# Vidro Roadmap

Vidro を FW として成立させるまでの段階的な発展計画。設計書
(`~/brain/docs/エデン 設計書.md`) の "Eden core" + "architecture pack" 2-layer
構造を、実装上のパッケージ分割に落とし込んだもの。

> **Status**: Living document (実装の進捗とともに更新する)
> **Last updated**: 2026-04-23

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

## Phase 1: `@vidro/core` 仕上げ — **ほぼ完了**

Reactive primitive + JSX runtime 層。SolidStart でいう Solid 本体相当。

- [x] `Signal<T>` / `Computed<T>` / `Effect` (class + factory)
- [x] `Ref<T>` / `batch(fn)` / `onMount(fn)` / `onCleanup(fn)`
- [x] Owner tree + `effectScope` (internal)
- [x] `<Show when>` / `<For each>` / `<ErrorBoundary>`
- [x] JSX runtime (`h` / `Fragment` / `mount`) + automatic runtime
- [x] JSX A 方式 compile transform (`{count.value}` がそのまま reactive)
- [ ] `<Switch>` / `<Match>` (Show の延長、軽)
- [ ] `<Suspense>` + JSX runtime children getter 化 (B-4、中)
- [ ] class / factory API の internal 化判断
      (Signal / Computed / Ref を factory 一本化するかどうか)

---

## Phase 2: `@vidro/router` — routing 層

Directory-based routing。ここから FW 色が出る。

- [ ] `routes/` ディレクトリ scan と route tree 構築
- [ ] 特殊ファイル: `index.tsx` / `layout.tsx` の入れ子 layout
- [ ] Dynamic segment `[id]`、Private `_` prefix
- [ ] `useParams` / `useSearchParam`
- [ ] Client-side navigation (`<Link>` + history API)
- [ ] **Vite plugin の本格化** (route tree の生成、型定義生成)

---

## Phase 3: `@vidro/server` — server / client 境界 ← **FW の核心**

設計書 §3.3 / §3.6 の本丸。型貫通の実装はここで完成する。

- [ ] `.server.ts` / `.client.ts` 拡張子境界のビルド時分離
- [ ] `loader` / `action` primitive (Remix 踏襲)
- [ ] `LoaderArgs<T>` / `ActionArgs<T>` / `PageProps<typeof loader>` の型
- [ ] Client から server 関数を呼ぶ RPC
  - **未決**: Remix 式 (navigation 時 fetch) vs tRPC 式 (import transform)
- [ ] `useAction<typeof action>` hook
- [ ] Result 型で fetch error を構造化 (throw させない方針)

---

## Phase 4: Data / Form / State

設計書 §3.7 / §3.8。Phase 3 の上に乗る。

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

1. **Phase 1 の残り** (`<Switch>` / `<Suspense>` / API internal 化) — 1〜2 セッション
2. **Phase 2 の最小版** — ここで FW っぽくなる、やってて楽しいフェーズ
3. **Phase 3 の loader のみ先行** — Phase 2 と組み合わせて "Remix 最小版" が動く
4. **Phase 3 の action / RPC** — 型貫通の山場
5. **Phase 5 Cloudflare target** → **Phase 6 architecture pack**

Phase 2 → 3 (loader) の間で**一度動くアプリが組める**タイミングが来るので、
そこで Vidro の体感がハッキリする。ここまで到達したら FW として最小成立。

---

## 未決論点の索引

Phase 進行中に判断する必要がある論点:

- **Signal API の class/factory 統一**: `project_signal_api_decision` memory
- **RPC 方式**: Remix 式 vs tRPC 式 (Phase 3 で決める)
- **PageProps 型の実装**: router が自動生成? 手書き `.d.ts`? (Phase 2-3 境界)
- **Architecture pack の正式名称**: "Vidro Rails" / "Orbit" 等 (Phase 6 着手時)

---

## 関連ドキュメント

- `~/brain/docs/エデン 設計書.md` — 設計の single source of truth
- `docs/decisions/` — 実装時の細かい判断 (ADR)
- `.claude/projects/.../memory/` — 作業継続のためのセッション間メモ
