# Vidro position vs Marko / Solid — modern reinterpretation の覚悟

> このノートは Vidro の identity と position を Marko / SolidStart との比較で
> 整理したもの。2026-05-01 の議論ログを Vidro 観点で再構成。
> 「自分が辿り着いた position は何者か」を明文化し、独自性を主張する範囲と
> 妥協する範囲を線引きする。

## 出発問い

Vidro の北極星 (memory `project_design_north_star.md`) は **「RSC の simpler 代替」**。
これを実現する設計判断として、HTML-first wire (notes 02) と temporal boundary
(時間軸境界) を組み合わせる方向に進めてきた。

しかし議論を進める中で次の疑問が浮上:

- 時間軸境界 + signal handoff という mechanism は **既存 fw に存在するのか?**
- HTML-first wire は **Vidro の独自性になるのか?**
- 自分は **既存 fw の再発明** をやってるだけではないのか?

このノートはこれらの問いへの答えを、Marko / Solid / SolidStart との比較で整理する。

---

## 時間軸境界 (temporal boundary) の整理

Vidro の核となる思想:

> **「server = 初期状態を作る装置」「client = そこから先のインタラクション」を
> 時間軸 (= hydration の前後) で線引きする**

これは RSC が空間軸 (= どの component がどっちで動くか) で境界を切ろうとして失敗したのに対する対角線。

### server が関わる 3 つのタイミングしかない

1. **Initial render**: server で JSX 走らせて signal 初期化 → HTML
2. **Mutation**: client から「これを変えて」と server に要求
3. **Re-read**: client から「別 / 新しいデータ欲しい」と server に要求

| タイミング        | Vidro 現状                                      |
| ----------------- | ----------------------------------------------- |
| 1. Initial render | `loaderData()` (ADR 0049) で着地済              |
| 2. Mutation       | `action()` + intent pattern (ADR 0051) で着地済 |
| 3. Re-read        | **gap** (空白)                                  |

3 (re-read) の設計が議論の中心。

### Re-read mechanism: 2 つに分割

「fresh data 欲しい」の動機は実は 2 種類あり、扱う primitive が異なる:

| トリガ                                  | URL に出る? | 扱う場所                                                |
| --------------------------------------- | ----------- | ------------------------------------------------------- |
| filter / search / page / sort           | Yes         | **`@vidro/router`** が searchParam 検知 → loader 再実行 |
| autocomplete / inline preview / polling | No          | **`@vidro/query`** がクライアント主導で取得 + cache     |

判断軸は **「この state を URL に出すべきか」** だけ。

両者は alternative ではなく complementary。

- Inertia / Hotwire は URL-driven しか持ってないので細粒度で詰む
- TanStack Query は client-driven しかないので "shareable URL" 文化が弱い
- Vidro が両方持って **目的別に正しい方を勧める** のが差別化点になる

### 3 段階の選択肢 (α / β / γ)

re-read 用の primitive 設計に α / β / γ の 3 段階:

- **α**: FW は何もしない、`fetch()` 使ってね (型は zod で自前)
- **β**: minimal primitive だけ提供、cache なし、「型付き RPC」だけ
- **γ**: cache + invalidation 含めて core

memory `project_cache_as_fw_concern.md` で「薄い core + 厚い optional pack」と
決めてるので γ 却下。**β + 別 pack (`@vidro/query`)** で着地。

### action vs query: 分けるか統合するか

候補:

- **i. 一本化**: `serverFn()` 的な統一 primitive (Solid の `useAction` 系)
- **ii. 二本化**: `action()` (mutation) と `query()` (read) を分ける

→ **ii (二本化) を選択**。理由:

- legibility test (memory `project_legibility_test.md`) 上「これは読みか書きか」が import 名で分かる
- reads は inherently cache を要請するが writes はしない (非対称性)
- → core は薄い `action()` のみ、`@vidro/query` (opt-in pack) が cache 含めた読み込みを担当

---

## Auto-strip — 構造的差別化点 (の正体)

「Vidro 独自の差別化点」候補として **auto-strip** (zero-JS component 自動省略) が挙がった。
これは structural differentiation たり得るか?

### 仕組み

- **React**: 全 component が再 render され得る → static でも JS ship 必須
- **RSC**: `"use client"` で **手動マーク** して境界を切る → user 操作必要、ミス余地あり
- **Vidro**: fine-grained reactivity で再 render しない → static component は HTML
  だけで完結、JS 不要

Vidro の compiler は **既に reactive slot を JSX 解析** しているため、
"signal 0 個" を判定して strip 候補にできる。

### 判定ルール (refined)

最初の議論で「signal 0 個 = strip OK」と提案したが、**client-only API**
(`window`, `localStorage`, `document`, `navigator` 等) の存在で破綻する。

正確な判定:

> **signal 0 個 かつ top-level に client-only API 参照が無い → strip OK**

idiom 上、Solid / Vidro では client-only API は `onMount` / effect 内に
閉じ込めるのが標準。これらは server で実行されないため、判定対象外にできる。

実装は AST 解析で:

- top-level の `window.*` / `document.*` 等の参照を検出
- `onMount` / `effect` 内なら無視
- 検出されたら strip 候補から除外

### 構造的差別化点と言える理由

- React は **再 render 制約** で、判定可能でも ship せざるを得ない
- RSC は手動マーキング (`"use client"`) で boundary 運用 = friction
- Vidro は **fine-grained だから再 render 制約が無い** + **マーキング不要で自動判定**
- → **「マーキング不要で auto-strip がデフォルト」** は Vidro が構造的に取れる position

ただし後述の通り Marko 6 が同じことを実装済なので、**Vidro 単独の発明ではない**。

---

## Hydration の仕組み比較 (SSR / RSC / Solid-Vidro)

「server で作った初期状態を client にどう渡すか」を 3 系統で整理。

### 古典的 SSR (React Pre-RSC)

1. server: tree を render → HTML
2. server: `getServerSideProps` でデータ取得
3. server: HTML に **データを script tag に埋め込み**:

```html
<div id="__next">...</div>
<script id="__NEXT_DATA__" type="application/json">
  { "props": { "user": { "name": "Asahi" }, "likeCount": 5 } }
</script>
```

4. client: data 読む → **同じ component tree を同じ data で再 render** → DOM 結合
5. → 重い、bundle 全部要る

### RSC (React Flight)

1. server: tree 実行 (server component + client component の placeholder mix)
2. **server component の "render 結果" を serialize** → React Flight 形式 (JSX 木の JSON 風表現)
3. client component は ID + props で参照 (本体は client bundle)
4. server: HTML (first paint 用) + RSC payload (Flight) を返す
5. client: Flight payload 読んで client component 部分を埋めながら tree 構築
6. → server component は client で再実行されない (= JS ship 不要)

**SSR と RSC の本質差**: SSR は「data を渡す」、RSC は「rendered tree を渡す」。

### Solid / Vidro (signal-based)

1. server: `loader()` がデータ返す
2. server: `signal(value)` 作られる、JSX が DOM 化
3. server: HTML + 小さい data blob を script tag に embed
4. client: data 読む → `signal(value)` 同じ初期値で作る
5. client: JSX 実行、ただし **新規 DOM 作らず既存 DOM に bind**
6. → 再 render 無し、bind setup だけ

| FW                | Wire                          | Client がやること                                      |
| ----------------- | ----------------------------- | ------------------------------------------------------ |
| 古典 SSR          | HTML + data (script tag)      | tree 全部 re-render → DOM diff → event 付ける          |
| RSC               | HTML + Flight (rendered tree) | server component 実行しない、client component だけ実行 |
| **Solid / Vidro** | HTML + 小さい data blob       | signal 初期化 → 既存 DOM に bind (re-render 無し)      |

### Vidro が HTML-first wire と相性いい理由

navigation 時を考えると:

- **React/SolidStart 系 (JSON wire)**: client が tree 持ってる前提 → JSON もらって client side で render
- **Vidro (HTML wire)**: server に HTML 作らせて、client は **「初期 hydration と同じ要領で signal init + DOM bind」** すればいい

つまり **「navigation = mini-SSR + mini-hydration」** という対称性が成立する。
これが「fine-grained だから HTML wire が成立する」と言ってた構造的理由。
React VDOM だと「navigation のたびに tree diff」が要るので HTML 直 swap は破綻する。

---

## Wire format の trade-off — HTML vs JSON

### Wire payload size

同じデータ、フォーマット違い:

- **JSON**: data そのまま (例: 100 posts で ~7.5KB)
- **HTML**: data + タグ / class / structure (例: 100 posts で ~20KB)

HTML は 2-4 倍大きいが gzip で差は縮む。実用上は致命傷じゃない。

### Client compose 柔軟性 (本質的差)

実は「データが client にあるか」じゃなく **「view コードが client にあるか」** が制約:

- **JSON wire**: 全 route の view code が client に ship → 自由に compose
  (`<List>`, `<Grid>`, `<RecentWidget>` 等を切り替えられる)
- **HTML wire**: view code は server に → 別 view が欲しいなら server に再 render を依頼

→ **client compose 柔軟性 = bundle size との trade-off**。

### Vidro の opinion

Default = HTML、必要な所だけ JSON pack 入れる:

| Use case                      | 性質                    | 適切な wire                  |
| ----------------------------- | ----------------------- | ---------------------------- |
| Blog / 記事サイト             | view 中心               | HTML-first (core)            |
| Marketing page                | view, SEO 必須          | HTML-first (core)            |
| 商品ページ (EC)               | view + 一部 interaction | HTML-first (core)            |
| Dashboard (sort/filter/chart) | データ加工大量          | JSON (`@vidro/query`)        |
| Admin panel (大規模 CRUD)     | データ加工大量          | JSON (`@vidro/query`)        |
| Real-time (chat, collab)      | live 性                 | JSON + WebSocket (将来 pack) |

実際 React + Next + TanStack Query を観察すると **「page は SSR、dashboard は Query」** という似た layering をしてる。
Vidro はそれを **default に明示してパッケージ化** したような構造。

---

## Marko との比較 (HTML-first 先行者)

「HTML-first + fine-grained + auto-strip」のセット自体は **Marko 6 (Tags API) が
商用 production で実装済**。Vidro の発明ではない。

### Marko の現在地

- eBay 製、production scale で長年運用
- Marko 6 + Tags API が現行 (2023-2024 major rewrite)
- **コンパイル型 fine-grained reactivity** (Solid の純 runtime と異なる、コンパイル時にもっと積極的に最適化)
- 公式ポジショニング: **"Marko for sites, Solid for apps"** (Marko 開発陣自身が apps 向きじゃないと認識)
- TypeScript: Input interface + generics + 型推論、結構しっかり対応
- DSL: `.marko` ファイルの「HTML superset」 (`<if>`, `<for>`, `<let>` 等)

### Vidro と被ってる部分

| 軸                             | Marko                   | Vidro                      |
| ------------------------------ | ----------------------- | -------------------------- |
| Wire                           | HTML 中心 + JSON props  | HTML default + JSON 3 例外 |
| Reactivity                     | Compile fine-grained    | 同 (Solid 系)              |
| Auto-strip / partial hydration | aggressive (商用実装済) | 計画中                     |
| Streaming SSR                  | あり                    | Phase C 着地               |
| Server-first mental model      | core                    | core                       |

→ **「HTML-first + fine-grained + 自動 hydration 最小化」のセット自体は Marko 先行**。
Vidro のオリジナリティ申請は不可。

### Vidro が差別化できる軸

| 軸                                 | Marko                         | Vidro                        |
| ---------------------------------- | ----------------------------- | ---------------------------- |
| Syntax                             | 独自 DSL (`.marko`)           | **JSX/TSX** (標準, AI 親和)  |
| State model                        | 暗黙 two-way binding          | **明示 signal** (Solid 寄り) |
| Component スコープ                 | Single File template          | function component           |
| 型貫通 (vertical type propagation) | 通常の TS support             | **identity の核**            |
| 4 層分離 + linter 強制             | なし                          | **opinion**                  |
| Intent pattern (ADR 0051)          | 別設計                        | **独自**                     |
| 2-layer product                    | core のみ                     | **core + arch pack**         |
| AI-native 設計軸                   | 意識してない                  | **明示**                     |
| Target                             | E-commerce (enterprise scale) | **個人 / hobby / cf scale**  |

### 特筆事項 3 つ

**1. Marko 自身が "for sites" を認めてる**

"Marko for sites, Solid for apps" は Ryan Carniato (Solid 作者 = Marko team の主要設計者の一人) の発言。
Marko は app 系ターゲットを狙ってない。
Vidro が「sites + 一定 interactive」を狙うと **Marko の射程外** に入る可能性。

**2. State model が違う**

- Marko: 暗黙 two-way data binding (`<let>` で宣言、自動 sync)
- Vidro: 明示 signal (Solid 風、`signal()` / `.value`)

Mental model が違うので、好みで選ばれる別物。Marko は "テンプレート言語の進化" 系、
Vidro は "Solid の進化" 系。

**3. Wire は Marko も完全 HTML-first じゃない**

Marko は islands 的にスペクトラムで scale (ultra-minimal なら HTML-only、リッチなら JSON+SPA)。
Vidro は「default HTML + 3 例外 JSON」を opinionated に明示する。
**Marko より振り切れてる**。

---

## SolidStart との比較

### SolidStart の選択

- ターゲット: 「React 嫌いだけど React mental model 維持したい人」
- React/Next の convention に寄せる: client routing / JSON wire / SPA-ish
- React からの migration 容易性を優先

### なぜ SolidStart は HTML-first にしないのか

技術的に不可能じゃない。**戦略 / 文化的選択**:

- React mental model から離れる → 学習コスト
- Router 設計の全面書き直し
- 「Solid は SPA 系」positioning がぶれる
- 既存ユーザーに不利益

**SolidStart は positioning 上 HTML-first にいきにくい**。
技術不可能じゃなく市場要因。

### Vidro が opinionated に行ける構造的理由

- 既存ユーザーゼロ → 中道に寄る義理なし
- 個人 / 趣味 / cf scale → 全 use case カバー不要
- 「合わない人は別の FW 使ってね」が言える

→ Vidro は **「振り切る贅沢」を許される位置**。
SolidStart は商業利用 / migration / 既存ユーザー要因で構造的に振り切れない。

これは Vidro の弱点ではなく **structural advantage**。
スタートアップが大企業より大胆に opinion 持てるのと同じ理屈。

---

## Vidro position: modern reinterpretation

ここまでの整理を踏まえた Vidro position の最終形:

> **「もし Marko が 2025 年に、JSX/TS/AI 時代の dev 文化の中で、
> enterprise 義理ゼロで 0 から作られたら？」の答え**

具体的な構成要素:

- **Wire 哲学**: Marko 由来 (HTML-first, auto-strip)
- **Reactive primitive**: Solid 由来 (明示 signal)
- **Authoring**: 現代的 (JSX/TSX, function component, ESM, Vite)
- **Opinion layer**: Vidro 独自 (4 層 / 型貫通 / AI 設計 / intent pattern)

= **Marko の wire DNA + Solid の primitive DNA + 現代 dev 文化 + 独自 opinion**

### これは proven pattern

「既存 idea を modern defaults で再構成する」は legitimate な戦略:

- **TypeScript** = JavaScript + 静的型
- **Tailwind** = utility CSS の reframing
- **Astro** = MPA + islands
- **Bun** = Node.js を modern defaults で
- **Vite** = Webpack を modern defaults で
- **SolidStart** = SolidJS + Next 的 meta-fw

raw 新規性じゃなく **modern 文化との fit** が effective な戦略。

### 1→10 synthesis としての覚悟

Vidro は 0→1 invention ではなく 1→10 synthesis。
これは恥じる必要なく、むしろ:

- Rails: MVC + AR + Convention の組み合わせ
- React: VDOM + component の組み合わせ
- Tailwind: utility CSS の再構成
- Vite: esbuild + ESM の組み合わせ
- Solid: fine-grained reactivity (Knockout / Vue 系譜) + JSX

成功した FW のほとんどは 1→10 で生まれてる。
**0→1 神話より 1→10 synthesizer の方が再現性ある**。

### 差別化のクレーム (正直版)

- **「HTML-first + fine-grained + auto-strip」は Marko 先行** (ユニーク主張不可)
- **「JSX + 明示 signal + HTML wire」は Vidro 独自** (Marko は DSL、SolidStart は JSON wire)
- **「型貫通 / 4 層 / AI 設計 / intent pattern」は Vidro 独自の opinion 層**
- **Target が違う**: Marko は B2B e-commerce、Vidro は個人 / hobby / cf

→ market 被りが少なく、文化 / 文脈 novelty で勝負できる position。

---

## Distribution 戦略 (将来オプション)

Vidro core (signal + JSX runtime) は Solid と同じことができるため、
将来の release 戦略として 3 つの path がある:

1. **Vidro 独立 FW として育てる** (Svelte / Solid 路線)
2. **Solid meta-framework に port** (opinion 80% は持っていける、20% は妥協 or upstream PR)
3. **Vidro = R&D playground、Solid port = product** (趣味は Vidro、固まったら Solid port)

memory `project_design_north_star.md` の「個人 / 趣味 / cf scale 向け、企業採用は狙わない」
方針に従い、**distribution 戦略は今決めなくていい**。

- 今: Vidro で好きにやって philosophy 磨く
- 中期: dogfood で opinion を validate
- 長期: その時の温度感で選ぶ

ドアは全部開けたまま走れる。

---

## 次にやること

1. memory に追記 (Marko 比較 / position / 1→10 synthesis)
2. 実機 dogfood 5 シナリオ検証に戻る
3. dogfood で「URL-driven re-read / client-driven re-read」両方の必要ケースを観察 → ADR 0052 起票
4. Ryan Carniato の dev.to 記事を継続的に読んで Vidro design に反映

## 関連

- `docs/notes/01-system-architecture.md` — boundary 3 種類、Vidro position
- `docs/notes/02-html-first-wire.md` — wire format design principle
- `docs/notes/03-cache-as-fw-concern.md` — 薄い core + 厚い optional pack
- `docs/notes/04-hono-inertia.md` — Inertia 参照点
- `docs/decisions/0049-loader-data-primitive.md` — initial render データ取得
- `docs/decisions/0051-derive-optimistic-with-intent.md` — mutation の intent pattern
- memory `project_design_north_star.md` — RSC simpler 代替の北極星
- memory `project_html_first_wire.md` — HTML-first wire 原則
- memory `project_cache_as_fw_concern.md` — core + arch pack の構造
- memory `project_legibility_test.md` — magic 許容基準
- [Marko: Compiling Fine-Grained Reactivity](https://dev.to/ryansolid/marko-compiling-fine-grained-reactivity-4lk4)
- [Marko for Sites, Solid for Apps](https://dev.to/this-is-learning/marko-for-sites-solid-for-apps-2c7d)
- [Introducing the Marko Tags API Preview](https://dev.to/ryansolid/introducing-the-marko-tags-api-preview-37o4)
