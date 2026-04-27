# Vidro Roadmap

Vidro を FW として成立させるまでの段階的な発展計画。設計書
(`~/brain/docs/エデン 設計書.md`) の "Eden core" + "architecture pack" 2-layer
構造を、実装上のパッケージ分割に落とし込んだもの。

> **Status**: Living document (実装の進捗とともに更新する)
> **Last updated**: 2026-04-27

---

## 語彙の整理

設計書の "Eden core" と、実装上の `@vidro/core` は**別物**なので混同しない。

| 呼び方                       | 含まれるもの                                            | 対応 OSS       |
| ---------------------------- | ------------------------------------------------------- | -------------- |
| 実装上の `@vidro/core`       | Signal / Effect / JSX runtime                           | **Solid 本体** |
| 設計書の "Eden core"         | 上記 + routing + server/client boundary + loader/action | **SolidStart** |
| 設計書の "architecture pack" | 4 層 linter + CLI template + DI pattern                 | **Rails**      |

設計書の "Eden core" は**複数パッケージに割れる**。reactive primitive と
routing / server boundary は責務が違うので、同じパッケージに詰めない。

---

## パッケージ分割案

```
@vidro/core        ← reactive + JSX runtime (Solid 相当)
@vidro/router      ← directory-based routing、layout nesting、useParams
@vidro/server      ← .server.ts / .client.ts 境界、loader/action、PageProps
@vidro/vite        ← Vite plugin (JSX transform + routing + server 分離を束ねる)
─────────────────────
(以下 architecture pack)
@vidro/arch        ← 4 層 linter rules (依存方向強制)
@vidro/cli         ← init / template (scale mode 対応)
```

---

## Phase 1: `@vidro/core` 仕上げ — **完了**

Reactive primitive + JSX runtime 層。SolidStart でいう Solid 本体相当。

- [x] `Signal<T>` / `Computed<T>` / `Effect` (class + factory)
- [x] `Ref<T>` / `batch(fn)` / `onMount(fn)` / `onCleanup(fn)`
- [x] Owner tree + `effectScope` (internal)
- [x] `<Show when>` / `<For each>` / `<ErrorBoundary>`
- [x] JSX runtime (`h` / `Fragment` / `mount`) + automatic runtime
- [x] JSX A 方式 compile transform (`{count.value}` がそのまま reactive)
- [x] `<Switch>` / `<Match>` (早い者勝ち / fallback / invoke-once)
- [x] JSX runtime: function children の返り値が Array / Node なら static スロット展開
- [x] `<Suspense>` + JSX runtime children getter 化 (ADR 0025/0029)
- [x] class / factory API の internal 化判断
      (factory 一本化、class は `export type` で internal 化 / ADR 0006)

---

## Phase 2: `@vidro/router` — routing 層 — **ほぼ完了**

Directory-based routing。ここから FW 色が出る。

- [x] `routes/` ディレクトリ scan と route tree 構築 (`route-tree.ts`)
- [x] 特殊ファイル: `index.tsx` / `layout.tsx` の入れ子 layout
- [x] Dynamic segment `[id]` (`apps/router-demo/src/routes/users/[id]/`)
- [ ] Private `_` prefix (未着手、優先度低)
- [x] `currentParams` / `currentPathname` signal (ADR 0028 系、`useParams` 相当)
- [ ] `useSearchParam` (未着手)
- [x] Client-side navigation (`<Link>` + history API、active state / aria-current 含む)
- [x] **Vite plugin の本格化** (`@vidro/plugin` の `routeTypes()` で型定義生成、
      `serverBoundary()` で `/__loader` middleware、`jsxTransform()` で A 方式 compile)
- [x] Error pages: `error.tsx` / `not-found.tsx` 規約 (ADR 0008/0010)

---

## Phase 3: `@vidro/server` — server / client 境界 ← **FW の核心** — 半分完了

設計書 §3.3 / §3.6 の本丸。型貫通の実装はここで完成する。

`@vidro/server` 単独パッケージは作らず、`@vidro/router` の `server.ts` +
`@vidro/plugin` の `serverBoundary()` の組み合わせで提供する方針 (現状)。

- [x] `.server.ts` 境界のビルド時分離 (ADR 0012 dev / ADR 0014 prod)
- [ ] `.client.ts` 拡張子規約 / lint rule (未着手)
- [x] `loader` primitive (`/__loader` endpoint で並列 fetch、ADR 0009)
- [x] `LoaderArgs<T>` / `PageProps<typeof loader>` / `LayoutProps` 型 (ADR 0011、
      `routeTypes()` plugin が `declare module` で `RouteMap` を augment)
- [ ] `action` primitive (Remix 踏襲)
- [ ] Client から server 関数を呼ぶ RPC
  - **未決**: Remix 式 (navigation 時 fetch) vs tRPC 式 (import transform)
- [ ] `useAction<typeof action>` hook
- [ ] Result 型で fetch error を構造化 (throw させない方針)

---

## Phase 3.5: SSR / Hydration — **streaming まで完了、最適化は残**

Phase 3 の loader が動いた後で寄り道として進めた、SSR + hydration の土台。
Phase 4 (data / form) より先にここを固めることで、`resource` primitive が SSR
往復で blink せず動く状態まで持っていった。

- [x] **Phase A**: bootstrap data injection (`<script id="__vidro_data">`、
      初回 `/__loader` 往復 skip / ADR 0015)
- [x] **Phase B**: universal renderer + hydrate primitive + boundary anchor (ADR 0016-0030、計 15 個)
  - `renderToString` / `hydrate` primitive
  - `<Show>` / `<Switch>` / `<For>` / `<ErrorBoundary>` の anchor 化
  - `children` getter 化、`foldRouteTree` getter 化
  - `<Suspense>` の SSR 対応 + `resource` の bootstrap key cache 命中
- [x] **Phase C-1+C-2**: streaming SSR (shell + tail、`renderToReadableStream` /
      `VIDRO_STREAMING_RUNTIME`、`composeResponseStream` / ADR 0031)
- [x] **Phase C-3**: out-of-order full streaming (per-boundary `ResourceScope` +
      resolve 順 emit、`__vidroSetResources` → `__vidroAddResources` partial
      merge / ADR 0033)
- [x] **Phase C-3 review fixes**: window resources 化 (race 根治) / shell-pass
      `controller.error` 明示 / cross-boundary key dev warn (ADR 0034)
- [x] **Phase C 段階 hydration の機構整備**: cursor 切り出し / start/end marker
      残置 / `__vidroPendingHydrate` registry / `window.__vidroResources` 直接
      lookup (ADR 0035)
- [x] **Phase C TTI 改善**: shell flush 直後 inline `<script>` boot trigger +
      bundle `<head>` async + `__vidroBoot` registry trampoline (ADR 0036)
- [ ] **Phase C 残**: boundary owner の dispose API
      (`tryHydrateBoundary` の root Owner leak 解消)
- [ ] **Phase C 残**: shell hydrate 中の fallback hydrate
      (cursor pause/resume stack or fallback 専用 sub-cursor)
- [ ] **Phase C 残**: true full out-of-order (内側 nested Suspense も独立 chunk 化)
- [ ] **Phase C 残**: shell-pass error → Phase A degrade 復活

---

## Phase 4: Data / Form / State — **resource primitive 着地、残りは未着手**

設計書 §3.7 / §3.8。Phase 3 の上に乗る。

- [x] `resource(fetcher, options?)` primitive (Solid 互換、bootstrap key、
      reactive source overload、Suspense 連動 / ADR 0028 / 0030 / 0032)
- [ ] `resource` 拡張: `mutate` API (Solid 楽観的更新)
- [ ] `resource` 拡張: AbortController (source 変化 / unmount で in-flight fetch 中止)
- [ ] `resource` 拡張: `keepPreviousData: false` option
- [ ] Form handling (Web Standards `<form>` + FormData)
- [ ] Zod integration、schema から form input → FormData → parse の型貫通
- [ ] TanStack Query connector (loader prefetch → component subscribe)
  - 独自 cache 実装との選択は将来判断
- [ ] 7 レイヤー state management の具体化
      (URL / Server / Session / App-global / Feature / Route / Component)

---

## Phase 5: `@vidro/workers` — Cloudflare first-class

設計書 §3.9。Primary target。

- [ ] Cloudflare Workers runtime 対応 (WinterCG 準拠)
- [ ] Hono 相互運用 (middleware レベル)
- [ ] `env` binding 抽象化 (`process.env` 直接禁止)
- [ ] Drizzle + D1 sample
- [ ] Bundle size 監視 (route 単位、10MB 制限)

---

## Phase 6: architecture pack — Rails 相当 (opt-in)

ここから設計書の 2 層目。Phase 1〜5 は "Eden core" で、ここからが "Rails 層"。

- [ ] `@vidro/arch`: 4 層 linter rules
  - `routes → application → domain ← infrastructure` 依存方向強制
- [ ] `@vidro/cli`: `vidro init --mode=minimal|standard|strict|enterprise`
- [ ] DI / Repository interface の template
- [ ] Scale mode ごとの template (minimal / standard / strict / enterprise)

---

## Phase 7: DevEx / 仕上げ

- [ ] HMR
- [ ] 型補完、エディタ統合
- [ ] Error overlay
- [ ] Docs site / playground
- [ ] 認証 middleware、protected routes
- [ ] i18n / a11y

---

## 現実的な進行順 (個人開発スケール)

`.server.ts` まで一気に行くと重いので、以下の順で体感しながら進める:

1. ~~**Phase 1 の残り**~~ — 完了
2. ~~**Phase 2 の最小版**~~ — 完了 (Private `_` prefix と `useSearchParam` だけ残)
3. ~~**Phase 3 の loader のみ先行**~~ — 完了 ("Remix 最小版" 相当が動く)
4. ~~**Phase 3.5 SSR**~~ — streaming SSR (Phase C-1+C-2+C-3) + 段階 hydration
   機構 (ADR 0035) + TTI 改善 (ADR 0036) まで完了
5. **Phase 3 action / RPC** ← イマココ
   - 型貫通の山場、RPC 方式の判断 (Remix 式 vs tRPC 式) が必要
6. **Phase 4 resource API 拡張** (action と組み合わせて mutate / AbortController を設計)
7. **Phase 3.5 残**: boundary owner dispose / fallback hydrate / true full out-of-order
8. **Phase 5 Cloudflare target** → **Phase 6 architecture pack**

Phase 2 + Phase 3 loader + Phase 3.5 SSR (streaming + 段階 hydration + TTI) が
揃った時点で **Vidro として最小成立 + production レベルの SSR 体験** が動く
(router-demo が out-of-order streaming + shell hydrate 先行発火 + boundary 単位
hydrate で blink 無く動く)。次は action / RPC で「書き込み側」を埋め、双方向
通信で FW の核心を完成させる。

---

## 未決論点の索引

Phase 進行中に判断する必要がある論点:

- ~~**Signal API の class/factory 統一**~~: 解決済み (ADR 0006、factory 一本化)
- ~~**PageProps 型の実装**~~: 解決済み (ADR 0011、`@vidro/plugin` の `routeTypes()`
  が `declare module` で `RouteMap` を augment、`PageProps<typeof loader>` で引く)
- **RPC 方式**: Remix 式 vs tRPC 式 (Phase 3 action 着手時に決める)
- **Architecture pack の正式名称**: "Vidro Rails" / "Orbit" 等 (Phase 6 着手時)
- **`@vidro/server` を独立パッケージ化するか**: 現状 `@vidro/router` + `@vidro/plugin`
  に分散実装、独立させる動機が出たら判断

---

## 関連ドキュメント

- `~/brain/docs/エデン 設計書.md` — 設計の single source of truth
- `docs/decisions/` — 実装時の細かい判断 (ADR)
- `.claude/projects/.../memory/` — 作業継続のためのセッション間メモ
