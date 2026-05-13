# Hibana Roadmap

Vidro の sibling、Hono の上に薄く乗る backend 主導 FW を縦串 MVP → 内部リファクタ →
発信までの段階で進めるための計画書。設計書 (= 哲学 / 主要決定) は別ファイル、
本書は実行計画と進捗状態を扱う。

> **Status**: Living document (実装の進捗とともに更新する)
> **Last updated**: 2026-05-14 (Step 5 follow-up 全完走、ADR 0082 Accepted 昇格)

---

## 立ち位置

Vidro と Hibana の対比は短く下記。詳しくは設計書を参照する。

|                  | Vidro                                    | Hibana                               |
| ---------------- | ---------------------------------------- | ------------------------------------ |
| 主導             | frontend-first                           | backend-first                        |
| route の決まり方 | filesystem 駆動 (= `app/posts/page.tsx`) | `app.get(path, handler)` 直書き      |
| UI の組織軸      | route と一体 (= filesystem)              | domain folder (= 強制せず推奨)       |
| 立場             | 趣味 / R&D の遊び場                      | 本命の bet (= ただし両方 playground) |

両者は `@vidro/core` を **共有 sibling** として持つ。`@vidro/core` の breaking change
は両方の dogfood smoke で確認する hygiene を持つ (= 詳細は memory
`project_hibana_vidro_interaction`)。

---

## パッケージ分割案

```
@vidro/core              ← reactive + JSX runtime (Vidro と共有、sibling 関係)
@vidro/hibana            ← hibana() middleware + c.render API + Vite plugin (= 縦串 MVP の本体)
─────────────────────
(将来の opt-in pack 候補、まだ無い)
@vidro/hibana-form       ← form helper、@vidro/form の Hibana 版相当
@vidro/hibana-zod        ← validator middleware、@vidro/zod の Hibana 版相当
```

Hibana 内部の層は単一パッケージ内のフォルダで `core / renderer / hono / vite / client`
に分ける。core は外側を import しない一方通行ルールを守る (= 設計書「内部の層構造と
依存方向」参照)。package 分割は必要になってから or 一生分けないままでも可。

---

## 設計書から引き継ぐ Open Questions

着手段階で確定するので、roadmap 上は **どの Step で決めるか** だけ書く。

| Open Question                                                                         | 確定 Step  |
| ------------------------------------------------------------------------------------- | ---------- |
| ~~`c.render` の名前確定 (= HonoX 衝突、候補 `c.page` / `c.view`)~~ → **据え置き決定** | Step 4 ✓   |
| ハードリロード時 vs navigation 時の server response の正確な contract                 | Step 5     |
| island の props serialize 制約 (Date / Map / class instance 等のルール)               | Step 4 (4) |
| ~~ADR numbering~~ → **Vidro 連番継続** (= ADR 0079 起票時に決定)                      | (= 完了)   |

---

## Phase 0: 前提確認 — **完了** (2026-05-11)

設計書時点で残ってた 3 つの前提を全て read で解消した段階。

- [x] `@vidro/core` の public API 確認: `signal` / `mount` / `h` (client) + `@vidro/core/server` の `renderToString` / `renderToStringAsync` / `renderToReadableStream`
- [x] リポジトリの置き場所: Vidro と同 monorepo の `packages/hibana/` 配下
- [x] 仮名: **Hibana** (火花、Hono = 炎から生まれる小さな spark) で確定、未公開のうちは変更可

---

## Phase 1: 縦串 MVP — **進行中** (Step 1〜3 + Step 5 完了、Step 4 残 / Step 6 未着手)

最小組み合わせ (= Hono + `@vidro/core` + Vite + client) で「server から HTML 返す
→ island hydrate → navigation」までを一直線に通す段階。差し替えは考えない。
ただし **core への逆流禁止** は守る (= 設計書 §内部の層構造)。

### Step 1: server から HTML 1 ページ返す (半日) — **完了** (commit 2076baf)

- [x] `packages/hibana/` scaffold (= `package.json` / `tsconfig.json` / `src/index.ts`)
- [x] `hibana()` middleware を Hono `MiddlewareHandler` で実装
- [x] Hono の `ContextRenderer` interface augmentation で `c.render(Component, props)` 型を提供
- [x] `c.setRenderer` で内部実装を差し替え、`@vidro/core/server.renderToString` で SSR
- [x] shell HTML (`<!DOCTYPE html>...`) で wrap、`c.html()` で Response
- [x] `apps/hibana-demo/` で domain folder pattern を体現 (= `src/domains/posts/{pages, schema.ts, service.ts, routes.ts}`)
- [x] `@hono/node-server` + `tsx` で起動、`curl localhost:3000/posts` で HTML 取得 smoke pass

### Step 2: 1 component を hydrate する (1-2 日) — **完了**

- [x] `.island.tsx` suffix で書ける component を 1 個追加 (例: `Counter.island.tsx`)
- [x] client bundle 生成 (= Step 3-a で vite build に統合)
- [x] shell HTML に `<script>` tag inject、island boundary marker を埋め込む
- [x] `@vidro/core` の `hydrate()` で client mount (= `hydrateRange` 経由)
- [x] **合流判断**: Vidro 既存の `__VidroIsland` 機構を Hibana から再利用 (= shared kernel 立場、重複実装回避)

### Step 3: Vite plugin 整備 (= cursor-based hydration の構造的前提)

memory `project_jsx_transform_mandatory_for_hydrate` の発見により、本来 Step 3 で optional automation
扱いだった Vite plugin は **hydrate を動かす core 機構**。Step 2 と構造的に分離不可なため、
Step 3 を 2 つに分割した:

- **Step 3-a**: `@vidro/plugin` の `jsxTransform()` を vite 経由で adopt する (= JSX transform 必須)
- **Step 3-b**: `@vidro/hibana/vite` 独自 plugin で `.island.tsx` を glob 自動発見 + virtual module 生成

#### Step 3-a: vite + jsxTransform adopt (1 日) — **完了**

- [x] apps/hibana-demo に vite + `@hono/vite-dev-server` install (= tsx watch + esbuild bundle 廃止)
- [x] vite.config.ts で `@vidro/plugin` の `jsxTransform()` を server/client 両方に適用
- [x] mode 分岐 (`mode === "client"` で client bundle、それ以外で server bundle)
- [x] `Counter.island.tsx` の手書き thunk (`{() => count.value}`) を除去、`{count.value}` 直書きで reactive 動作
- [x] browser smoke: `Count: 0 → 1 → 2` click で update 確認

#### Step 3-b: .island.tsx 自動発見 + virtual module

scope を 2 つに分割:

- **Phase A**: 手書き import 撲滅 (= 機構の発見側を整備)
- **Phase B**: defineIsland も internal 化 (= user 語彙を `.island.tsx` 書くだけに絞る)

##### Phase A: 手書き import 撲滅 — **完了**

- [x] 最小 Vite plugin を `packages/hibana/src/vite.ts` に追加 (= `@vidro/hibana/vite` で export)
- [x] `import.meta.glob("/src/**/*.island.tsx", { eager: true })` で発見、AST 解析不要 (= 設計書原則)
- [x] virtual module `virtual:hibana/islands` で `islandMap` (= name → component default export) を提供
- [x] HMR の単位 = file = bundle unit で揃える (= vite の glob 機構が自動検知)
- [x] `@vidro/hibana/vite-client` triple-slash directive で virtual module の TS 型を提供
- [x] apps/hibana-demo の `src/client.ts` を `setupIslandHydration(islandMap)` 2 行に縮退
- [x] dogfood smoke: browser で `Count: 0 → 1` reactive update 確認、手書き import 撲滅後も regression なし

##### Phase B: defineIsland 撲滅 + client.ts 自動生成

scope を 2 つに分割:

- **Phase B-1**: defineIsland 撲滅 + name 自動付与 (= `.island.tsx` default export を plugin が auto-wrap)
- **Phase B-2**: client.ts 撲滅 + clientScript option 撲滅 (= shell HTML inject を plugin に移管)

##### Phase B-1: defineIsland 撲滅 + name 自動付与 — **完了**

- [x] `hibanaVite()` plugin に `transform` hook 追加 (= `enforce: "pre"`、jsxTransform より先に走る)
- [x] `.island.tsx` の default export を AST で `defineIsland(<original>, "<filename>")` に置換
- [x] island name を filename から自動付与 (= `Counter.island.tsx` → `"Counter"`)
- [x] 既に `defineIsland(...)` 手書きされてる case は skip (= 二重 wrap 防止 + 互換維持)
- [x] FunctionDeclaration / ClassDeclaration / Expression の 3 形態に対応
- [x] babel parser/traverse/generate を `packages/hibana` の dependencies に追加
- [x] apps/hibana-demo の Counter.island.tsx を `export default function Counter(...)` 1 文に simplify
- [x] dogfood smoke: SSR marker emit + browser `Count: 0 → 1` reactive update 確認

##### Phase B-2: client.ts 撲滅 + clientScript option 撲滅 — **完了**

- [x] client bundle entry を plugin が virtual で生成 (= `virtual:hibana/client-entry`、user の `client.ts` 自体を撲滅)
- [x] `hibana()` middleware の `clientScript` option 撲滅 (= shell HTML の `<script>` tag を内部固定、`process.env.NODE_ENV` で dev/prod auto-detect)
- [x] `defineIsland` の export を internal 化 (= `@vidro/hibana/internal` に移動、user-facing `@vidro/hibana` から削除)
- [x] dogfood smoke: dev で reactive update + `vite build` で `dist/static/client.js` + `dist/server.js` 生成
- [ ] **合流判断**: `@vidro/plugin` (= Vidro 専用) と独立 OR 共通 helper を core に切り出す — 持ち越し (= Phase 2 で扱う)

### Step 4: `c.render(Component, props)` API 確定 (1-2 日)

- [x] 命名衝突解決: `c.render` のまま行く (= HonoX / Hono+Inertia 整合、第 19 周目決定)
- [x] shell HTML の per-route customization (= `<head>` 内の title / meta / link) = ADR 0079 着地
- [ ] layout component pattern (= 親 layout が子 page を slot で受ける形が Hibana 流に合うか検討)
- [ ] `defineIsland<T>()` helper を optional 追加検討 (= props serialize 可能性の type check)
- [ ] **合流判断**: JSX runtime contract ADR (= Vidro 側 B') と整合、`h()` を "shared kernel" の public IR として宣言

### Step 5: navigation (HTML swap) (2-3 日) — **完了** (= 第 22-23 周目、ADR 0080 Accepted)

設計判断: ADR 0080 (`docs/decisions/0080-hibana-html-swap-navigation.md`) + memory `project_hibana_step5_design`

4 軸確定:

| 軸                             | 確定                                                                             |
| ------------------------------ | -------------------------------------------------------------------------------- |
| intercept                      | `<Link>` component (明示 opt-in、書き忘れは素の `<a>` で MPA fallback)           |
| wire                           | partial HTML                                                                     |
| boundary marker                | `<Frame>{children}</Frame>` (Frame ≒ Flame、Hibana = 火花 + Hono = 炎で命名統一) |
| 共通祖先計算                   | Approach B (server header `X-Hibana-Layouts`)                                    |
| ADR 0081 (= layout 機構本採用) | 中立 (= 両 app dogfood で実証)、Step 5 完走後に判断                              |
| 将来最適化余地                 | filesystem-based 採用時に Approach C (URL から layout 計算)                      |

Phase 分割 (= tasks #1-#8 に対応、全完走):

- [x] **Phase 0** 設計 doc + roadmap update + ADR 0080 起票 (Draft) — `5518596`
- [x] **Phase 1** `<Link>` + `<Frame>` JSX component 実装 (= packages/hibana/src/{link,frame}.ts) — `72d1f88`
- [x] **Phase 2** client intercept + 最深 Frame swap (= 同 layout 内 navigation 対応) — `dc79f5c`
- [x] **Phase 3** server header `X-Hibana-Layouts` 付与 + partial HTML response — `0469b5e` + `e1b6ee8` (encodeURIComponent fix)
- [x] **Phase 4** client 共通祖先計算 + layout 切り替え対応 — `7bcf5e1`
- [x] **Phase 5** dev warning (Frame 書き忘れ検出) + scroll restoration + popstate — `d5b7d6d`
- [x] **Phase 6** dogfood (apps/hibana-demo + apps/hibana-demo-fs 両方 + Playwright smoke) — `8f351fd`
- [x] **Phase 7** code-reviewer Critical 2 件 fix (= AbortController + null fallback) + ADR 0080 Accepted 昇格 + memory update — `47b9d1d` + Phase 7 commit
- [ ] **合流判断**: `@vidro/router` の cache 戦略 (= memory `project_cache_as_fw_concern`) と整合検討

却下案 (= ADR 0080 詳細参照):

| 案                                                    | 却下理由                                                                                                                      |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 全 `<a>` 自動 boost                                   | "書いた分だけ" 哲学と逆、Hibana 他機構 (island/layout/metadata) と粒度ズレ                                                    |
| full HTML wire                                        | `<Link>` の存在意義 (= 最適化) が薄まる、共通 layout を毎回 fetch する無駄                                                    |
| JSON tree wire                                        | virtual DOM 無いので構造的に不可                                                                                              |
| `<Outlet />` self-closing                             | `LayoutComponent` から children prop 削除する breaking change、書き忘れで page 完全表示されない (= graceful degradation 違反) |
| MVP: 最深 Frame だけ swap + layout 変更時 full reload | 「逃げ手」、user 哲学「FW 価値最大化」と逆                                                                                    |
| Approach C (URL 計算) 即採用                          | filesystem-based 採用を前提化、ADR 0081 (= 旧 0080、layout 機構) を縛る                                                       |

### Step 5 follow-up: form submit も HTML swap (1-2 日) — **完了** (= 第 26 周目、ADR 0082 Accepted)

設計判断: ADR 0082 (`docs/decisions/0082-hibana-form-submit-navigation.md`) + memory [[project_hibana_crud_dogfood_findings]]

第 25 周目 CRUD dogfood で発見した痛み:

- **F2** = POST 失敗時に URL bar = action target、reload で再 POST 警告
- **F3** = form submit が `<Link>` intercept 対象外、毎回 full reload + persistent island state リセット

3 軸確定:

| 軸                  | 確定                                                             |
| ------------------- | ---------------------------------------------------------------- |
| intercept           | `<Form>` component (= 明示 opt-in、ADR 0080 `<Link>` と sibling) |
| form state location | server 再 render (= props snapshot、Pure server 流維持)          |
| URL update policy   | 成功時のみ pushState、失敗時 URL 据え置き (= F2 解消)            |

機構: ADR 0080 の partial wire / 共通祖先計算 / Frame swap / `Vary: Accept` を **そのまま再利用**、server 側変更ゼロ。`fetch` の `redirect: "follow"` で 303 自動 follow、`response.redirected` で success/failure 分岐。

Phase 分割 (= tasks #1-#8 に対応、全完走):

- [x] **Phase 0** 設計 doc + roadmap update + ADR 0082 起票 (Draft) — `5b817ba`
- [x] **Phase 1** `<Form>` JSX component 実装 (= packages/hibana/src/form.ts + index.ts export) — `f297309`
- [x] **Phase 2+3** client submit intercept + redirect follow + 成功時のみ pushState — `4978ea2`
- [x] **Phase 4+5** dev warning + 両 app dogfood (apps/hibana-demo + apps/hibana-demo-fs CRUD form を `<Form>` 化、Playwright smoke) — `808bba2`
- [x] **Phase 6** code-reviewer agent review + Critical 2 件 fix (= C-1 4xx fallback + C-2 fallback URL) — `d272d5c`
- [x] **Phase 7** ADR Accepted 昇格 + memory update

却下案 (= ADR 0082 詳細参照):

| 案                                           | 却下理由                                                                            |
| -------------------------------------------- | ----------------------------------------------------------------------------------- |
| 全 `<form>` 自動 boost                       | "書いた分だけ" 哲学と逆、ADR 0080 で `<Link>` を選んだ整合性                        |
| client-side reactive form state (useForm 流) | Hibana 中核哲学 2 (= server は reactivity 知らない) と不整合、Pure server 流崩壊    |
| 失敗時にも pushState                         | F2 の根、解消したい挙動そのもの                                                     |
| 失敗時に form action 別 URL に倒す           | server に routing 規約追加、handler 自由度を制約、案 B が変更ゼロで成立するので不要 |

flash 機構 (= success message 表示) は本 ADR から外し、別 ADR (= 候補 0083) で扱う。F2/F3 解消は redirect follow + pushState 制御だけで成立する。

### Step 6: 小さいサンプルアプリ (1 週)

- [ ] 2-3 routes、複数 domain、island 2-3 個、navigation 経由遷移込みの demo
- [ ] 設計書 3 哲学を実装で体現するサイズ (例: tiny blog or memo app)
- [ ] README + 起動手順、Phase 3 発信時の素材として使える形

---

## Phase 2: 内部リファクタ・抽象の検証

縦串 MVP が動いた後、`core / renderer / hono / vite / client` の境界が健全か検証する
段階。違和感あれば core を直す (= 破壊的変更 OK、まだ初期)。

- [ ] core ⟷ renderer ⟷ hono ⟷ vite ⟷ client の依存 graph を可視化
- [ ] `import/no-restricted-paths` で一方通行ルールを ESLint 強制
- [ ] core が外側を知らないか機械的に検証 (= `@vidro/core` 内に `hono` / `vite` の文字列が出てきたら fail)
- [ ] 違和感あれば core を直す
- [ ] **合流判断**: Vidro 側 内部アーキ A (= `@vidro/core` 内部 hub-and-spoke 整理) と motivation 共有、ADR 起票時期を揃える

---

## Phase 3: 発信

研究プロトタイプ立ち位置で謙虚に。世界初 NG、過大評価 NG。

- [ ] 動くサンプル (= Phase 1 Step 6 のアプリ) を GitHub + ライブデモで公開
- [ ] 発信記事 1 本目: 「Hono の上に薄く乗る backend-first FW を作ってる話」想定
- [ ] Pitch: 「Hono ecosystem の旗艦 backend-first FW」(= Hono コミュニティ向け)
- [ ] Vidro 側の発信戦略 (= memory `feedback_publishing_strategy` の RSC シリーズ等) と独立 channel として走らせる

---

## Vidro 計画との合流ポイント

memory `project_hibana_vidro_interaction.md` で詳述。4 つの合流 hygiene を 1 行で再掲:

1. **`@vidro/core` の breaking change**: 両 dogfood で smoke 取る習慣
2. **island 機構の共有**: Step 2 で `__VidroIsland` 再利用判断、独立実装は回避
3. **JSX runtime contract ADR の射程**: Vidro 側 B' を書く時 "shared kernel" 立場で
4. **ALS scope primitive 共有**: Hibana で env scope 入れたくなったら `createScope` (= ADR 0065) を使う

---

## 関連

- 設計書 (canonical philosophy): `~/brain/docs/backend-first FW 設計骨格.md`
- 経緯デイリー: `[[2026-05-11]]` (brain)
- Vidro 側 roadmap: [`docs/roadmap.md`](./roadmap.md)
- Vidro 設計書: `~/brain/docs/エデン 設計書.md`
- ADR: `docs/decisions/` (= Hibana ADR の置き場は初 ADR 起票時に決定)
