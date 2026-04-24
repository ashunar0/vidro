# 0008 — `error.tsx` 規約 + Router での error 統合

## Status

Accepted — 2026-04-24

## Context

Phase 3 で `server.ts` の `loader` を導入したことで、loader が throw した async
error を画面に表示する規約が必要になった。core の `<ErrorBoundary>` (ADR 0004)
は既に存在するが、async (Promise reject) は **直接 catch できない** (effect 内で
`void Promise.then(...)` してる error は同期 throw とは別軸)。

論点は 4 つ:

1. **規約か手動か**: `error.tsx` 規約を入れるか、ユーザーが手で `<ErrorBoundary>` を置くか
2. **API**: error.tsx の props 形
3. **階層**: 1 ファイルだけか、階層的に最寄り適用か
4. **reset の挙動**: state 解除のみか、loader 再実行か

設計書 (`~/brain/docs/エデン 設計書.md`) 5 節「実装で詰める論点」の "Error handling"
が該当領域。設計書 3.5 で「特殊ファイル: index.tsx / layout.tsx / server.ts (最小
3 種類)」と書いてあるので、**規約を増やすかどうか** がそもそもの判断点。

## Options

### 論点 1: 規約 vs 手動

- **A. `error.tsx` 規約を入れる** (Remix / SvelteKit / Next.js App Router 流)
  - 自動で boundary 配置、convention over configuration
  - 特殊ファイルが 3 → 4 種類に増える
- **B. ユーザーが layout で `<ErrorBoundary>` を手で置く** (Solid 流)
  - 規約なし、core primitive そのまま
  - 配置は完全にユーザー責任
- **C. Router built-in default error UI** (規約なし、デフォ表示のみ)

### 論点 2: error.tsx の API

- **A.** `{ error, reset, params }` (Remix / Next.js 流)
- **B.** `{ error }` 最小
- **C.** loader の戻り値型と紐付ける `ErrorPageProps<typeof loader>`

### 論点 3: 階層

- **A.** 階層的 lookup (深い prefix が優先、無ければ親 segment / root)
- **B.** root の error.tsx 1 個固定

### 論点 4: reset の挙動

- **A.** state 解除のみ (Solid `<ErrorBoundary>` の reset と同じ思想で children を再 mount)
- **B.** 同 pathname に再 navigate (loader 再実行)
- **C.** 何もしない (UI が retry button を出す自由)

## Decision

- 論点 1 → **A (`error.tsx` 規約)**
- 論点 2 → **A (`{ error, reset, params }`)**
- 論点 3 → **A (階層的 lookup)**
- 論点 4 → **B (同 pathname 再 navigate = loader 再実行)**

公開 API:

```ts
// @vidro/router
export type ErrorPageProps = {
  error: unknown;
  reset: () => void;
  params: Record<string, string>;
};
```

```tsx
// routes/error.tsx (root) または routes/users/error.tsx (nested)
import type { ErrorPageProps } from "@vidro/router";

export default function ErrorPage({ error, reset, params }: ErrorPageProps) {
  return (
    <div>
      <p>{error instanceof Error ? error.message : String(error)}</p>
      <button onClick={reset}>Retry</button>
    </div>
  );
}
```

## Rationale

### 論点 1: A (規約)

- Remix / SvelteKit / Next.js App Router いずれも `error.tsx` 規約を採用 → **業界標準**
- 設計書哲学 4「AI-native な規約」: ファイル名と責務の 1:1 対応、判断点を減らす → 規約あり
- 手動 (B) だと「どこに `<ErrorBoundary>` を置くか」が毎回判断点になる
- C (built-in default) は表示の柔軟性が皆無 → 却下

特殊ファイルが 3 → 4 種類に増えるのは設計書 3.5 の "最小 3 種類" 方針に反するが、
**error 表示は loader と地続きで、規約で済ませる方が trade-off が良い**と判断。
設計書 3.5 を 4 種類に更新済み。

### 論点 2: A (`{ error, reset, params }`)

- error 単独 (B) だと retry の導線がない
- `ErrorPageProps<typeof loader>` (C) は魅力的だが、loader が throw する error の型は
  通常 `unknown` (`Error` 派生かどうかも保証されない) → generic で絞っても価値が薄い
- params は最寄り route が抽出した値。404 ケース (route match なし) では空 object
- `error: unknown` は ADR 0004 と統一 (throw の値に型保証はない)

### 論点 3: A (階層的)

- Remix / SvelteKit と同じ。深い場所での error は近い error.tsx に出す方が UX が良い
- 実装は layout と同じ pathPrefix-based lookup → 既存の `layoutPathToPattern` を再利用
- 浅い prefix の error.tsx を fallback として使えるので、ユーザーは root だけ書けば
  全 route カバーできる (= 段階的に nested を追加できる)

### 論点 4: B (loader 再実行)

- A (state 解除のみ) は Solid `<ErrorBoundary>` の挙動だが、loader error の場合は
  **loader を再実行しないと同じ error にしか戻らない**。retry として機能しない
- B はネットワーク一時失敗 / fetch race 等の典型シナリオで実用的
- C (UI 自由) は設計の責任放棄 → reset を提供する以上、明確な意味を持たせる
- Next.js の reset() も「segment を再 mount = loader 再実行」で同じ思想

## Consequences

### 実装

- `route-tree.ts` に `ErrorEntry` 追加。`compileRoutes` で `error.tsx` を収集、
  pattern は `layoutPathToPattern` (prefix match) を共用
- `matchRoute` の戻り値に `error: ErrorEntry | null` を追加。pathPrefix 最長
  (= 最寄り) を選ぶ
- `Router` の effect 内で 3 系統の error 処理:
  - **loader (async)**: `try/catch` で囲み、catch したら leaf を error.tsx で置換
  - **render (sync)**: leaf を `<ErrorBoundary>` で wrap、fallback で error.tsx
  - **module load 失敗**: Promise.all の `.catch()` で素朴な default 表示
- `errorMod` 自体の load 失敗は default 表示にフォールバック (`.catch(() => null)`)
- `reset()` の実装: Router 内に `reloadCounter = signal(0)` を持ち、effect が
  `void reloadCounter.value` で dependency 登録。`reset()` で increment して effect
  を再実行する
  - `currentPathname.value` を同値 set しても signal が notify しないため、
    `currentPathname` を trigger に使えない

### API 制約

- error.tsx の **default export が必須** (component 規約)
- error.tsx 内で再 throw されると core ErrorBoundary が catch、それも fallback だと
  外側 (= mount 元) に bubble up
- loader 中の error は **`onError` callback が呼ばれない** (ErrorBoundary 経由しない
  ルート)。Router 内の `console.error` のみ。今後ログ送出が要件になったら Router
  props で `onLoaderError` を露出する余地

### Layout との関係

- loader / render error の場合も **layouts は外側に維持** される (Remix / SvelteKit
  と同じ)。header / nav が壊れない
- ただし layout 自身が render error を起こしたケースは現状未対応 (layout の loader も
  別タスク、layout を `<ErrorBoundary>` で wrap してない)

### 設計書への影響

- 3.5「特殊ファイル: 最小 3 種類」→ **4 種類** に更新
- 3.6「API 提供予定」に `ErrorPageProps` を追加
- 5 節「Error handling」を未決から **決定済み** に格上げ

## Revisit when

- **layout 階層に loader を入れる時**: layout 自身の render / loader error を
  どう扱うか (layout も独立して error.tsx に置換する? layouts の入れ子のうち一番
  深いものから error にする?)
- **streaming / Suspense を入れる時**: loader が pending 中の placeholder と
  error の関係 (`<Suspense fallback>` と error.tsx の優先順)
- **error 種別の判別が必要になった時**: status code / NotFoundError / 認証エラー
  などを error.tsx 側で分岐したい場合、`ErrorPageProps` に種別フィールドを増やす
  か、別 props (例: `useRouteError()` 的 hook) を提供するか
- **server boundary を入れた時** (vite plugin): loader が server で実行されると
  serialize された error が client に届く。`error instanceof Error` が成り立たない
  ケースが出るので、error 受け渡しの規約を設計書側で詰める必要がある
