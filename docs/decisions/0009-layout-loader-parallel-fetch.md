# 0009 — `layout.server.ts` 規約 + 並列 fetch + `LayoutProps<L>`

## Status

Accepted — 2026-04-24

## Context

Phase 3 第 1 弾で `server.ts` の `loader` (leaf) + `error.tsx` を入れた (ADR 0008)。
続く Phase 3 第 2 弾では、設計書 3.7「Data Fetching 三位一体」の「並列 fetch、
waterfall 解消」の検証として **layout 自身が loader を持てる**ようにする。

layout loader があると:

- dashboard sidebar に current user を出す (`/dashboard/layout`)
- breadcrumb に上流 entity の name を出す (`/users/:id/layout`)
- 並列 fetch で waterfall 解消 (Remix / SvelteKit の真髄)

これらを可能にするために、論点は 3 つ:

1. **layout loader の配置**: どのファイルに書くか (既存 `server.ts` と同居するか別ファイルか)
2. **`LayoutProps` の型形**: loader 有無の両対応をどう表現するか
3. **loader error の階層伝播**: layout loader が throw したときの error.tsx 選択ルール

## Options

### 論点 1: layout loader の配置

`routes/users/` には既に `layout.tsx` と `index.tsx` が同居し、`/users` は leaf でも
あり子 route の layout 親でもある。ここに loader を追加するとき、どこに書くか。

- **A-1.** `routes/users/server.ts` に `loader` と `layoutLoader` を両方 export
  - ファイル数増えない
  - ファイルを開くまで loader の責務 (leaf 用 / layout 用) が視覚的に区別できない
  - 命名規約 (`loader` vs `layoutLoader`) で内部的に区別
- **A-2.** `routes/users/layout.server.ts` を新設 (layout loader 専用ファイル)
  - `.tsx` と `.server.ts` が 1:1 ペアで責務が明確
    (`layout.tsx` ↔ `layout.server.ts`、`index.tsx` ↔ `server.ts`)
  - 設計書 3.3「`.server.ts` で server boundary」とも整合
- **A-3.** `routes/users/_layout/` / `_page/` で dir 分離 (Next.js app router 流)
  - 完全に分離されるが、toy runtime には過剰

### 論点 2: `LayoutProps` の型形

Phase 3 第 1 弾の `LayoutProps<Params>` は `{ params, children }`。layout loader が
来ると `data` も渡したい。loader **なし** layout も依然ある (root layout など)。

- **B-1.** conditional type で 1 つの型に畳む
  - `LayoutProps` (generic 省略) → `{ params, children }`
  - `LayoutProps<typeof loader>` → `{ data, params, children }`
- **B-2.** 別 type 名に分ける (`LayoutProps` + `LayoutPropsWithLoader<L>`)
  - 読みやすいが、使い分けが毎回判断点になる
- **B-3.** `data: undefined` を常に含めて loader 無し layout でも受け取らせる
  - 型的に手抜き、user が `data?.user` 的 defensive 書き方を強いられる

### 論点 3: loader error の階層伝播

layout loader が throw した場合、どの error.tsx を使うか。

- **C-1. 厳密 (Remix 流)**: throw した layer より **外側** の最寄り error.tsx を使う
  - 内側 error.tsx は「その layout が正常に mount できない前提」では使えない
    (users/error.tsx は users layout の内側なので、users layout の loader が死んだら使えない)
  - UX は正しい: 壊れた layout より外側は維持される
  - 実装は階層判定が要る (error.tsx の pathPrefix と error layer の pathPrefix を比較)
- **C-2. 単純化 (MVP)**: leaf loader error と同じく「pathname 最寄り (深い prefix 優先)」
  - 実装が leaf loader error の流用で済む
  - 厳密に正しくない (内側 error.tsx が使われ得る)
  - toy runtime としては動作確認に十分

## Decision

- 論点 1 → **A-2 (`layout.server.ts` 新設)**
- 論点 2 → **B-1 (conditional type で一本化)**
- 論点 3 → **C-2 (単純化、MVP)**

公開 API:

```ts
// @vidro/router
import type { LoaderArgs, LayoutProps } from "@vidro/router";

// routes/users/layout.server.ts
export async function loader(_args: LoaderArgs) {
  const res = await fetch("https://api.example.com/users");
  if (!res.ok) throw new Error(`Failed: ${res.status}`);
  return { users: await res.json() };
}

// routes/users/layout.tsx
import type { loader } from "./layout.server";

export default function UsersLayout({ data, children }: LayoutProps<typeof loader>) {
  return (
    <div>
      <p>{data.users.length} users</p>
      {children}
    </div>
  );
}
```

loader なし layout は従来通り:

```tsx
// routes/layout.tsx
export default function RootLayout({ children }: LayoutProps) {
  return <div>{children}</div>;
}
```

型定義:

```ts
type AnyLoader = (args: LoaderArgs<any>) => Promise<unknown>;

export type LayoutProps<L extends AnyLoader | undefined = undefined> = L extends AnyLoader
  ? {
      data: Awaited<ReturnType<L>>;
      params: Parameters<L>[0]["params"];
      children: Node;
    }
  : {
      params: Record<string, string>;
      children: Node;
    };
```

並列 fetch の実装:

```ts
// router.tsx の effect 内
const loadLoaderResults = Promise.all([
  ...match.layouts.map((l) => runServerLoader(l.serverLoad, match.params)),
  runServerLoader(match.server ? match.server.load : null, match.params),
]);
```

layer 間は Promise.all で並列。layer 内 (module load → loader 実行) は sequential。

## Rationale

### 論点 1: A-2 (layout.server.ts)

- `.tsx` = UI、`.server.ts` = server 専用コード、という設計書 3.3 の拡張子規約が
  layout にもそのまま適用できる。メンタルモデル 1 つで済む
- ファイルを開かなくても「これは何の loader か」が視覚的に判別できる
- A-1 (同 server.ts に両方 export) は書き手の負担を増やす (どっちにどっちを書くか毎回判断)
- A-3 (dir 分離) は toy 段階で overkill、設計書 3.5「特殊ファイルは最小」方針にも反する

特殊ファイルが 4 → 5 種類に増えるが、`.server.ts` 拡張子は既存の規約の延長で、
「新種目」というより「layout.tsx の server counterpart」と自然に解釈できる。

### 論点 2: B-1 (conditional type)

- `PageProps<L>` は loader 必須前提 (leaf は loader なしなら自前で `{ params }` 書けばいい)
- layout は loader 有無どちらも **layout として同じ責務** を持つので、1 つの型で両対応
  したい動機が強い
- conditional type は TS の標準機能で、`L = undefined` デフォルトを組み合わせれば
  generic 省略時も動く → 使い勝手は `LayoutProps` / `LayoutProps<typeof loader>` と
  直感的
- B-2 (型分離) は使い分け判断が毎回発生、設計書哲学 5「型貫通」と噛み合わない
- B-3 (`data: undefined` 常時) は型の意味が弱い。`data` 無しの層で user に defensive
  書き方を強いる

### 論点 3: C-2 (MVP 単純化)

- Phase 3 第 2 弾の主眼は **並列 fetch そのもの** の検証。error 階層伝播は別テーマ
- 既存の leaf loader error 処理 (最寄り error.tsx、layouts は外側維持) が流用できる
  ので実装量が少ない
- Revisit when で明記した通り、実運用してキモさを感じたら C-1 に切り替える余地を残す

具体実装: `loaderResults[i]` (i=0 が最外 layout、最後が leaf) を走査し、**最初の
error** (= 最も外側) を採用。その layer から内側 (layouts + leaf) を error.tsx で
置き換え、外側 layouts は正常 render する。

## Consequences

### 実装

- `route-tree.ts`:
  - `LayoutEntry.serverLoad: ServerModuleLoader | null` を追加 (同 dir layout.server.ts)
  - `compileRoutes` で `/layout.server.ts` を `/server.ts` より**先に**判定
    (`endsWith` 順序で leaf server に吸い込まれないように)
  - `layoutServers` Map に一旦貯めて、layouts 構築後に 2-pass で紐付け
  - `filePathToLayoutServerPath` helper 追加
- `router.tsx`:
  - `runServerLoader(loadFn, params)` helper: module load + loader 実行を一体で実行し、
    成功/失敗を `{ data, error }` に包む。module load 失敗と loader throw を一様に扱う
  - effect 内で leaf + 全 layout loader を `Promise.all` で並列起動
  - `errorIndex` を走査で求め、`errorIndex === -1` なら通常経路、それ以外なら
    errorIndex layer を error.tsx で置換して外側 layouts で fold
  - layout にも `data` を渡すよう `default({ params, data, children })` で呼び出し
- `page-props.ts`:
  - `LayoutProps<L>` を conditional type に変更 (backward compat: `LayoutProps` のまま
    で loader なし shape が取れる)

### API 制約

- layout.tsx の loader も **非同期関数必須** (他の loader と同じ)
- layout.server.ts に `loader` 以外を export しても router は無視 (将来 `action` を
  入れるなら同じパターン)
- layout loader と leaf loader は **params のみ** を引数に取る → 親 data を子 loader
  から参照する API は提供しない (設計判断、下記参照)

### 親 data の共有は提供しない

layout loader → leaf loader に data を渡す API は **意図的に作らない**。理由:

- 渡す API を作ると waterfall になる (layout loader 完了を待って leaf loader を起動)
- URL (`params`) から直接必要な data を引けるように DB/API を設計するのが健全
- 実用では TanStack Query のキャッシュ共有 (同 queryKey → 1 回 fetch) / app-global
  signal 経由で十分カバーできる (設計書 3.7 の三位一体の #2 に相当)

### Layout render error は未対応

- 今回 `ErrorBoundary` で wrap してるのは **leaf component のみ**。layout 自身が
  render error を起こしても catch されない (mount 失敗がそのまま Router effect
  の `.catch()` に bubble し、default error 表示になる)
- 実装コストが低く見えて boundary 配置に判断が要るため、別 ADR で詰める

### 設計書への影響

- 3.5「特殊ファイル」→ `layout.server.ts` を追加 (4 → 5 種類)
- 3.6「API 提供予定」に `LayoutProps<L>` の conditional type 形を反映
- 3.7「Data Fetching 三位一体」の #1 Route-level loader を「並列 fetch 実装済み」に格上げ

## Revisit when

- **layout loader error の階層伝播を正しくしたい時** (C-1 への移行):
  `errorIndex` を求めた後、その layer の `pathPrefix` より**浅い**か**同じ** error.tsx
  を選ぶロジックに差し替える。`matchedErrors` を pathPrefix 昇順に持って index 比較
- **layout render error を catch したい時**:
  各 layout の default() 呼び出しを `ErrorBoundary` で wrap するか、effect 内で
  layout 構築を try/catch するか。render phase と async error の整合性検討が要る
- **親 data → 子 loader のアクセスが本当に必要になった時**:
  `LoaderArgs` に `parentData` を生やす案を再検討。ただし waterfall トレードオフ
  (parent 完了を待つ) を ADR で明記して受け入れる
- **server boundary を入れた時** (vite plugin):
  loader が server プロセスで実行される形になると、layout loader も同じく server
  呼び出しになる。並列 fetch の batching (1 回の request で全 layer 分) を検討する余地
- **Suspense / streaming を入れる時**:
  並列 fetch の結果が揃う前に外側 layout から先に render し、内側を Suspense 境界に
  する選択肢。現在は全 loader 解決後に一括 render している
