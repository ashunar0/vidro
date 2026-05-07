# 0065 — Scope context が `await` を生き残る (unctx 経由 AsyncLocalStorage migration)

## Status

**Accepted** — 2026-05-07 (54th session、user 合意取得済 = unctx 路線)

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

| memory                       | 関係                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------ |
| `project_design_north_star`  | RSC simpler 代替の核 = async server component を成立させるため、scope migration が前提条件 |
| `project_pending_rewrites`   | 「並行 request safety は AsyncLocalStorage 化で将来対応」項目を本 ADR で前倒し対応         |
| `project_3tier_architecture` | 「環境で切る」哲学 = unctx 経由で runtime 抽象、Workers / Node / Deno / Bun 全対応         |
| `project_legibility_test`    | scope API は`runWithIslandScope` の意味論不変、call site は変更なし = 読み手影響ゼロ       |

## Options

### 論点 1: AsyncLocalStorage を直書きするか、抽象 library を経由するか

#### (1-A) `unctx` library 経由 (= 採用本命)

```ts
import { createContext } from "unctx";

const islandCtx = createContext<IslandSeqState>({ asyncContext: true });

export function runWithIslandScope<T>(fn: () => T): T {
  return islandCtx.call(new Map(), fn);
}

export function getIslandSeqState() {
  return islandCtx.use({ default: () => null });
}
```

- pros: ALS 検出 + browser fallback を library が吸収、自前ロジック不要
- pros: TanStack Start / Nuxt / Nitro が裏で使ってる枯れた pattern (= unjs エコシステム)
- pros: 将来 Nitro 採用時に整合 (= 同じ unjs 路線)
- cons: dependency 1 個追加 (= 但し zero-dep tiny library、bundle 影響ほぼゼロ)

#### (1-B) `node:async_hooks` 直書き + 自前 fallback

```ts
let storage: AsyncLocalStorage<IslandSeqState> | null = null;

if (typeof globalThis.AsyncLocalStorage !== "undefined") {
  storage = new globalThis.AsyncLocalStorage();
}

export function runWithIslandScope<T>(fn: () => T): T {
  if (storage) return storage.run(new Map(), fn);
  // browser fallback
  const prev = currentScope;
  currentScope = new Map();
  try {
    return fn();
  } finally {
    currentScope = prev;
  }
}
```

- pros: dependency ゼロ
- cons: 各 scope file に同じ条件分岐コードが入る (= 4 ファイル分 duplicate)
- cons: 将来 unctx 採用時に rename 作業発生

#### (1-C) `.server.ts` / `.client.ts` でファイル分割

- 各 scope file を server (ALS) / client (sync) で分けて bundler に解決させる
- pros: bundle が clean
- cons: ファイル数増、Vidro の `.server.ts` 規約は user 向け、core 内部で使うのは異質

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

- 論点 1: **(1-A) `unctx` library 経由** ─ ALS 検出 + browser fallback を委譲、unjs エコシステム整合
- 論点 2: **(2-A) per-render scope 4 件すべて (island/resource/suspense/streaming)** ─ まとめて async-safety 化
- 論点 3: 上記 3 件 (mount/observer/owner) は **migrate 不要** ─ async 越え不要なため

### unctx の使い方規約 (= 各 scope file 共通)

```ts
import { createContext } from "unctx";

const ctx = createContext<T>({ asyncContext: true });

export function runWithXxxScope<T>(fn: () => T): T {
  return ctx.call(initialValue, fn);
}

export function getCurrentXxx(): T | null {
  return ctx.use({ default: () => null });
}
```

- `{ asyncContext: true }` で ALS 経由 (= await 越え) 動作
- `call` は sync / async どちらの fn も透過 (= return 値そのまま、Promise なら Promise)
- `use({ default: () => null })` で「scope なし時 null」を表現 (= 既存 `currentScope === null` 動作維持)

### Cloudflare Workers compatibility flag

ALS は Workers では `nodejs_compat` または `nodejs_als` flag が必要:

```toml
# wrangler.toml
compatibility_flags = ["nodejs_als"]  # or "nodejs_compat"
```

`nodejs_als` の方が軽量 (= AsyncLocalStorage のみ)。`nodejs_compat` は Node.js builtins 全般を有効化 (= unctx が他の Node API を内部で使う場合に備える)。Vidro は async 機構のみ必要なので **`nodejs_als` が最小**。

### Scope (= 本 ADR で扱う / 扱わない)

| 項目                                                          | 本 ADR で扱う?                       |
| ------------------------------------------------------------- | ------------------------------------ |
| `unctx` 依存追加 (`packages/core/package.json`)               | ✅                                   |
| 4 scope file を `unctx` 経由で書き換え                        | ✅                                   |
| 既存 sync test の通過確認 (= semantic 維持)                   | ✅                                   |
| async 越し scope preservation の test 追加                    | ✅                                   |
| Workers compatibility_flags 設定 (apps/router-demo/apps/blog) | ✅                                   |
| `mount-queue` / `observer` / `owner` の migration             | ❌ (= async 越え不要、論点 3 で確定) |
| `currentPathname` / `currentParams` の ALS 化                 | ❌ (= router 側、別 ADR で扱う)      |
| `async function Component()` 自体のサポート                   | ❌ (= **ADR 0066 で扱う**)           |
| Nitro 採用 / multi-runtime build                              | ❌ (= 別 ADR、本 ADR は unctx だけ)  |

## Open Questions (= 実装着地時に詰める detail)

> 注: 確定論点は Decision 参照。本 section は実装段階で詰める detail のみ。

1. **unctx の version / API 詳細**
   - `unctx` v2.x (執筆時) の `createContext({ asyncContext: true })` を使う想定
   - `call` vs `callAsync` の使い分け (= 仕様で決まっているはず、実装で確認)
   - return type 推論の調整 (= TS で sync / async 両対応の wrapper 型)

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

- **dependency 1 個増加** (`unctx`) — zero-dep tiny だが pure module 維持の哲学から微妙に外れる
- **Workers の compatibility flag が必要** — `nodejs_als` (or `nodejs_compat`) の設定漏れがあると runtime error
- **migrating tests の verification コスト** — 既存 test 数百件の通過確認、初回 run で網羅
- **bundle size +N KB の懸念** — 実測で確認、unctx は < 1KB の見込みで実害ゼロ想定

### 既存 ADR との関係

- **ADR 0064 (Resource 1-pass 統一)**: 直接の依存元。本 ADR で resource-scope を ALS 化することで、async tree walk が完全に async-safe になる
- **ADR 0060 (partial hydration)**: islandScope を ALS 化、`__VidroIsland` の seq counter が async 越しに動く
- **ADR 0058 (`.server.tsx` semantics)**: `.server.tsx` で reactive primitive 禁止は不変、async function 許容追加 (= ADR 0066) の前提
- **ADR 0033 (out-of-order streaming)**: streamingScope を ALS 化、boundary registry が async 越しに動く
- **ADR 0029 (Suspense)**: suspenseScope を ALS 化、Suspense ↔ Resource の連携が async 越しに動く

## Affected files (実装着地時)

- `packages/core/package.json`: `unctx` dependency 追加
- `packages/core/src/island-scope.ts`: `unctx` 経由に書き換え
- `packages/core/src/resource-scope.ts`: 同上 (`runWithResourceScope` / `getCurrentResourceScope`)
- `packages/core/src/suspense-scope.ts`: 同上 (`runWithSuspenseScope` / `getCurrentSuspense`)
- `packages/core/src/streaming-scope.ts`: 同上 (`runWithStream` / `getCurrentStream`)
- `apps/router-demo/wrangler.toml` (or 同等): `compatibility_flags = ["nodejs_als"]` 追加
- `apps/blog/wrangler.toml` (or 同等): 同上
- `packages/core/tests/scope-async-survival.test.ts` (新規): async 越し preservation の test

## Validation (= Accepted 化までに実施)

- 既存 ADR (0001-0064) との矛盾なし check (上記表で実施済)
- 既存 memory との整合 check (上記 cross-check 表で実施済)
- `unctx` v2.x の API 仕様確認 (= context7 等で実装着地時に最終確認)
- `feature-dev:code-reviewer` agent review (memory `feedback_review_in_workflow` per、Accepted 化前 or 実装 commit 直前)

## Next steps (= Accepted 化後)

### 段階的 commit 推奨順序

1. **Phase 1**: `unctx` dependency 追加 + `island-scope.ts` を unctx 経由に書き換え (= 動作 baseline 確認)
2. **Phase 2**: `resource-scope.ts` migration
3. **Phase 3**: `suspense-scope.ts` migration
4. **Phase 4**: `streaming-scope.ts` migration
5. **Phase 5**: Workers compatibility_flags 追加 + apps の動作確認 + async 越し test 追加

各 Phase で既存 test (合計 353 件) pass 確認。1 ファイルずつ migrate するので、半端な状態でも残りは元のまま動く (= regression risk 最小化)。

### 完了後 ADR 0066 着手

ADR 0066 (= async server component native) は本 ADR の上に load。AsyncScope + h() 拡張 + VAsyncSlot などの仕事は本 ADR と独立、scope context が async-safe になっていれば自然に着地する。
