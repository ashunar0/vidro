# 0065 — Scope context が `await` を生き残る (AsyncLocalStorage + 共通 helper migration)

## Status

**Accepted** — 2026-05-07 (54th session、user 合意取得済 = raw ALS + 共通 helper 路線、unctx は sync API 衝突で実装段階で却下)

依存: ADR 0064 (Resource 1-pass 統一、全 Phase 着地済)
load 先: ADR 0066 (async server component native、本 ADR の上に load)
関連: ADR 0058 (`.server.tsx` semantics)、ADR 0060 (partial hydration、islands seq counter)

## Context

### 痛みの起点 — `try/finally` push/pop は `await` を生き残れない

ADR 0066 で `async function Component()` を実装するために、`.server.tsx` 内 component が `await` を含む場合の **scope state preservation** が必須となる。

具体例:

```tsx
// posts/index.server.tsx
async function PostsIndex() {
  const posts = await db.posts.findAll();
  return (
    <section>
      {posts.map((p) => (
        <LikeButton postId={p.id} />
      ))}
    </section>
  );
  //                                  ↑ island (.tsx)、__VidroIsland 経由
}
```

JS engine semantics で `return <section>...</section>` の評価 (= `h()` chain) は `await` 完了後の continuation で走る。**この時点で per-render scope state は null** になっている。

### 故障メカニズム

現状 `island-scope.ts` (= 他の scope ファイルも同形) は:

```ts
let currentScope: IslandSeqState | null = null;

export function runWithIslandScope<T>(fn: () => T): T {
  const prev = currentScope;
  currentScope = new Map();
  try {
    return fn(); // ← async fn なら Promise を return してすぐ抜ける
  } finally {
    currentScope = prev; // ← finally pop が await のずっと前に走る
  }
}
```

= **`fn` が Promise を返した瞬間 finally で scope pop**。後で JS engine が microtask で continuation を resume する時には scope は null。`__VidroIsland` が seq counter を引けず破綻、partial hydration が壊れる。

これは islandScope 固有の問題ではなく、**Vidro の per-render scope state すべてに共通する構造的問題**。

### 既存 memory の roadmap 整合

memory `project_pending_rewrites` に既に記載済み:

> **SSR 中の currentPathname global signal 切替**: 並行 request safety は AsyncLocalStorage 化で将来対応

= 「将来 ALS 化」が roadmap に既にある。本 ADR で前倒し対応 + scope ファイル群にも同じ施策を適用。

### 目指す behavior

```tsx
async function PostsIndex() {
  const posts = await db.posts.findAll();
  return (
    <section>
      {posts.map((p) => (
        <LikeButton postId={p.id} />
      ))}
    </section>
  );
}
```

= **post-await の JSX 評価で islands / resource / suspense / streaming すべての scope state が引ける** = ADR 0066 の前提条件。

### Vidro 哲学整合 (memory cross-check)

| memory                       | 関係                                                                                                |
| ---------------------------- | --------------------------------------------------------------------------------------------------- |
| `project_design_north_star`  | RSC simpler 代替の核 = async server component を成立させるため、scope migration が前提条件          |
| `project_pending_rewrites`   | 「並行 request safety は AsyncLocalStorage 化で将来対応」項目を本 ADR で前倒し対応                  |
| `project_3tier_architecture` | 「環境で切る」哲学 = ALS 経由で runtime 抽象、Workers / Node / Deno / Bun 全対応 + browser fallback |
| `project_legibility_test`    | scope API は`runWithIslandScope` の意味論不変、call site は変更なし = 読み手影響ゼロ                |

## Options

### 論点 1: AsyncLocalStorage の使い方 (= 直書き / 抽象 library / 共通 helper)

#### (1-A) raw `AsyncLocalStorage` + 共通 helper (`scope-context.ts`) (= 採用)

```ts
// scope-context.ts (新規 internal helper)
let ALS: ALSCtor | undefined;
try {
  ALS = (globalThis as any).AsyncLocalStorage;
} catch {}

export function createScope<T>() {
  if (ALS) {
    const storage = new ALS<T>();
    return {
      runWith: <R>(value: T, fn: () => R): R => storage.run(value, fn),
      getCurrent: (): T | null => storage.getStore() ?? null,
    };
  }
  // browser fallback (sync state、await 越え preservation なし)
  let current: T | null = null;
  return {
    runWith: <R>(value: T, fn: () => R): R => {
      const prev = current;
      current = value;
      try {
        return fn();
      } finally {
        current = prev;
      }
    },
    getCurrent: (): T | null => current,
  };
}

// island-scope.ts (after migration)
const islandScope = createScope<IslandSeqState>();
export function runWithIslandScope<T>(fn: () => T): T {
  return islandScope.runWith(new Map(), fn);
}
export function getIslandSeqState() {
  return islandScope.getCurrent();
}
```

- pros: **sync passthrough を保つ** (= `runWithXxxScope(fn)` が sync return、callsite の `renderToString` 等を変えずに済む)
- pros: ALS の `als.run(value, fn)` 自体が sync passthrough (= fn の return 型をそのまま返す)、async 子孫には ALS が preserve する
- pros: dependency ゼロ
- pros: browser fallback も helper 1 ファイルに集約 = 各 scope file はビジネスロジック純化
- cons: 将来 unjs / Nitro 路線に踏み込んだ時に unctx に rename したくなる (= helper 1 ファイル 5 行差し替えで完了、影響軽微)

#### (1-B) `unctx` library 経由

```ts
const ctx = createContext<IslandSeqState>({ asyncContext: true, AsyncLocalStorage });
ctx.callAsync(new Map(), fn); // ← Promise<T> を返す
ctx.call(new Map(), fn); // ← sync だが ALS 経路を使わない (= await 越え preservation 効かない)
```

- 致命的な問題: `callAsync` が **常に Promise 返す** = `runWithIslandScope` が async になる連鎖変化、`renderToString` まで async 化が必要
- `call` は sync だが ALS 経路を使わない (= 意義喪失)
- = **unctx は sync API + ALS preservation の両立が無い**、Vidro 既存 API と衝突
- pros: TanStack / Nitro / Nuxt 整合
- cons: 上記 sync passthrough 不可問題、本ケースでは不採用
- 将来 Nitro 採用 + 全コード async 化判断が出たら再検討

#### (1-C) `.server.ts` / `.client.ts` でファイル分割

- 各 scope file を server (ALS) / client (sync) で分けて bundler に解決させる
- pros: bundle が clean
- cons: ファイル数 4 → 8 倍、Vidro の `.server.ts` 規約は user 向け、core 内部 idiom として異質

### 論点 2: どの scope file を migrate するか

#### (2-A) per-render scope 4 件すべて (= 採用)

- `island-scope.ts` ← partial hydration の seq counter (ADR 0060)
- `resource-scope.ts` ← Resource bootstrap registry (ADR 0064)
- `suspense-scope.ts` ← Suspense pending count (ADR 0029)
- `streaming-scope.ts` ← streaming SSR boundary registry (ADR 0033)

#### (2-B) 部分的に migrate (= async component で確実に必要なものだけ)

- 例えば `island-scope` だけ
- pros: 影響範囲最小
- cons: 後で他の scope で同じ問題踏む = まとめてやる方が clean

### 論点 3: migrate しない state (= 確認用)

以下は **migrate 不要** と判定:

- `mount-queue.ts`: server で discard、client で sync 動作 = ALS 不要
- `observer.ts` (`currentObserver`): effect tracking、async 中は使わない (`.server.tsx` で signal/effect 禁止 by ADR 0058) = ALS 不要
- `owner.ts` (`currentOwner`): effect/cleanup 登録、`.server.tsx` async では effect 禁止 + handleError は closure で owner 捕捉済 = ALS 不要

## Decision

3 論点すべて確定 (= 54th session、user 合意取得済):

- 論点 1: **(1-A) raw `AsyncLocalStorage` + 共通 helper (`scope-context.ts`)** ─ sync passthrough を維持、callsite API 不変、unctx は sync + ALS の両立不可で却下、将来 Nitro 採用時に helper 差し替えで unctx 経由に rename 可能
- 論点 2: **(2-A) per-render scope 4 件すべて (island/resource/suspense/streaming)** ─ まとめて async-safety 化
- 論点 3: 上記 3 件 (mount/observer/owner) は **migrate 不要** ─ async 越え不要なため

### scope-context helper の使い方規約 (= 各 scope file 共通)

```ts
import { createScope } from "./scope-context";

const xxxScope = createScope<T>();

export function runWithXxxScope<T>(fn: () => T): T {
  return xxxScope.runWith(initialValue, fn);
}

export function getCurrentXxx(): T | null {
  return xxxScope.getCurrent();
}
```

- `createScope<T>()` 内で **server runtime** (Node / Workers / Deno / Bun) なら `globalThis.AsyncLocalStorage` を使う、**browser** なら sync state にフォールバック
- `runWith(value, fn)` は ALS の `als.run` を呼ぶ → fn が sync ならその return 型をそのまま返す、async なら Promise<T> を返す (= sync passthrough、callsite の API 不変)
- `getCurrent()` は ALS の `getStore()` または fallback の current variable を返す、scope なしなら null

### Cloudflare Workers compatibility flag

ALS は Workers では `nodejs_compat` または `nodejs_als` flag が必要:

```toml
# wrangler.toml
compatibility_flags = ["nodejs_als"]  # or "nodejs_compat"
```

`nodejs_als` の方が軽量 (= AsyncLocalStorage のみ)。`nodejs_compat` は Node.js builtins 全般を有効化。Vidro は ALS のみ必要なので **`nodejs_als` が最小**。

### Scope (= 本 ADR で扱う / 扱わない)

| 項目                                                          | 本 ADR で扱う?                                 |
| ------------------------------------------------------------- | ---------------------------------------------- |
| `scope-context.ts` 新規 (= raw ALS + browser fallback helper) | ✅                                             |
| 4 scope file を helper 経由で書き換え                         | ✅                                             |
| 既存 sync test の通過確認 (= semantic 維持)                   | ✅                                             |
| async 越し scope preservation の test 追加                    | ✅                                             |
| Workers compatibility_flags 設定 (apps/router-demo/apps/blog) | ✅                                             |
| `mount-queue` / `observer` / `owner` の migration             | ❌ (= async 越え不要、論点 3 で確定)           |
| `currentPathname` / `currentParams` の ALS 化                 | ❌ (= router 側、別 ADR で扱う)                |
| `async function Component()` 自体のサポート                   | ❌ (= **ADR 0066 で扱う**)                     |
| Nitro / unjs 採用 / multi-runtime build                       | ❌ (= 別 ADR、本 ADR は raw ALS + helper のみ) |

## Open Questions (= 実装着地時に詰める detail)

> 注: 確定論点は Decision 参照。本 section は実装段階で詰める detail のみ。

1. **`globalThis.AsyncLocalStorage` の TS 型**
   - Workers では `globalThis.AsyncLocalStorage` が global にある (= `@cloudflare/workers-types` で型定義)
   - Node.js では `node:async_hooks` の `AsyncLocalStorage` が global ではない
   - 共通 helper は `globalThis.AsyncLocalStorage` を runtime detect、TS は `unknown as ALSCtor` で型を narrow
   - 実装時に Node 環境で globalThis に AsyncLocalStorage を polyfill すべきか確認

2. **既存 test の通過確認範囲**
   - sync 経路 (= renderToString / hydrate / partial hydration) の動作不変を assert
   - 影響範囲: `tests/render-to-string.test.ts`, `tests/render-to-string-async.test.ts`, `tests/render-to-readable-stream.test.ts`, `tests/hydrate.test.ts` 等
   - 大半が semantic 維持なら通る見込み、念のため確認

3. **async 越し preservation の test 追加方法**
   - 単純 unit test: `runWithIslandScope(map, async () => { await sleep(1); return getIslandSeqState() === map; })` パターン
   - integration test: ADR 0066 着地後に `await db.findAll(); return <Island/>` で実用 path 確認

4. **Workers 以外の runtime での確認**
   - Node.js: AsyncLocalStorage ネイティブ → 動作するはず
   - Deno: Node compat 経由
   - Bun: Node compat 経由
   - Browser: ALS なし → unctx が sync fallback、ただし async function component は browser で動かない (= ADR 0066 で client guard) ので fallback semantics で問題なし
   - dogfood で確認するのは Workers + Node。それ以外は spec verification のみ

5. **bundle size 影響**
   - unctx は zero-dep tiny library、minify 後 < 1KB の見込み
   - 計測: bench/bundle-size/ で migration 前後の数値比較 (memory `project_bundle_size_bench`)

## Consequences

### Pros

- **scope state が `await` を生き残る** = ADR 0066 (async server component) 着手の前提条件達成
- **memory `project_pending_rewrites` の roadmap 項目を前倒し対応** = 並行 request safety 課題が同時解決
- **unjs エコシステム整合** = 将来 Nitro 採用時の前準備、TanStack 路線と歩調合致
- **call site 変更ゼロ** = `runWithIslandScope` 等の API は不変、user code / test code 影響なし
- **runtime 抽象化** = Workers / Node / Deno / Bun / Browser ぜんぶ動く (browser は async 機構不要なので sync fallback で OK)

### Cons / 残るリスク

- **Workers の compatibility flag が必要** — `nodejs_als` (or `nodejs_compat`) の設定漏れがあると runtime error
- **migrating tests の verification コスト** — 既存 test 数百件の通過確認、初回 run で網羅
- **bundle size 影響** — helper 1 ファイル (~30 行)、無視できるレベル
- **unjs / Nitro 路線への切替コスト** — 将来 Nitro 採用時に `scope-context.ts` 1 ファイルを unctx 化する手間 (= helper 内部書き換え 5 行レベル、callsite 影響ゼロ)

### 既存 ADR との関係

- **ADR 0064 (Resource 1-pass 統一)**: 直接の依存元。本 ADR で resource-scope を ALS 化することで、async tree walk が完全に async-safe になる
- **ADR 0060 (partial hydration)**: islandScope を ALS 化、`__VidroIsland` の seq counter が async 越しに動く
- **ADR 0058 (`.server.tsx` semantics)**: `.server.tsx` で reactive primitive 禁止は不変、async function 許容追加 (= ADR 0066) の前提
- **ADR 0033 (out-of-order streaming)**: streamingScope を ALS 化、boundary registry が async 越しに動く
- **ADR 0029 (Suspense)**: suspenseScope を ALS 化、Suspense ↔ Resource の連携が async 越しに動く

## Affected files (実装着地時)

- `packages/core/src/scope-context.ts`: **新規作成** (= raw ALS + browser fallback helper)
- `packages/core/src/island-scope.ts`: `scope-context` 経由に書き換え
- `packages/core/src/resource-scope.ts`: 同上 (`runWithResourceScope` / `getCurrentResourceScope`)
- `packages/core/src/suspense-scope.ts`: 同上 (`runWithSuspenseScope` / `getCurrentSuspense`)
- `packages/core/src/streaming-scope.ts`: 同上 (`runWithStream` / `getCurrentStream`)
- `apps/router-demo/wrangler.toml` (or 同等): `compatibility_flags = ["nodejs_als"]` 追加
- `apps/blog/wrangler.toml` (or 同等): 同上
- `packages/core/tests/scope-async-survival.test.ts` (新規): async 越し preservation の test

## Validation (= Accepted 化までに実施)

- 既存 ADR (0001-0064) との矛盾なし check (上記表で実施済)
- 既存 memory との整合 check (上記 cross-check 表で実施済)
- `globalThis.AsyncLocalStorage` の Workers / Node 動作確認 (= 実装着地時に dogfood で最終確認)
- `feature-dev:code-reviewer` agent review (memory `feedback_review_in_workflow` per、Accepted 化前 or 実装 commit 直前)

## Next steps (= Accepted 化後)

### 段階的 commit 推奨順序

1. **Phase 1**: `scope-context.ts` helper 新規作成 + `island-scope.ts` を helper 経由に書き換え (= 動作 baseline 確認)
2. **Phase 2**: `resource-scope.ts` migration
3. **Phase 3**: `suspense-scope.ts` migration
4. **Phase 4**: `streaming-scope.ts` migration
5. **Phase 5**: Workers compatibility_flags 追加 + apps の動作確認 + async 越し test 追加

各 Phase で既存 test (合計 353 件) pass 確認。1 ファイルずつ migrate するので、半端な状態でも残りは元のまま動く (= regression risk 最小化)。

### 完了後 ADR 0066 着手

ADR 0066 (= async server component native) は本 ADR の上に load。AsyncScope + h() 拡張 + VAsyncSlot などの仕事は本 ADR と独立、scope context が async-safe になっていれば自然に着地する。
