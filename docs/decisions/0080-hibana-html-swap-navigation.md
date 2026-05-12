# 0080 — Hibana navigation を HTML swap で実装する (`<Link>` + `<Frame>` + partial HTML wire)

## Status

**Accepted** — 2026-05-12 (= 第 23 周目で Phase 7 着地、両 app dogfood pass + code-reviewer agent Critical 2 件 fix 経由)

経緯:

- 2026-05-12 (= 第 21 周目完走): Hibana Phase 1 Step 4 (3) layout 機構 = handler-based 版 (cc047f0) + filesystem-based 版 (3aad670) 両方着地、apps/hibana-demo / hibana-demo-fs で並走 dogfood pass、ADR (旧 0080) layout 機構の本採用判断は **保留** に
- 2026-05-12 (= 第 22 周目、73rd session): ADR 0080 を Step 5 (HTML swap navigation) 用に転用 (= ADR は起票順、慣習どおり)。layout 機構の本採用判断は **ADR 0081** にずらす予定。Step 5 設計確定 (= 4 軸決定) + Phase 0 起票
- 2026-05-12 (= 第 23 周目): Phase 1-6 全完走 (= 両 app Playwright dogfood pass、partial wire + 共通祖先計算 + popstate + scroll restoration + dev warning)。code-reviewer agent review で Critical 2 件 (= C-1 並行 navigation race / C-2 X-Hibana-Common-Ancestor null fallback) を fix 後、Phase 7 で Accepted 昇格

着地時 commit:

| commit    | Phase              | 内容                                                                       |
| --------- | ------------------ | -------------------------------------------------------------------------- |
| `5518596` | Phase 0            | ADR 0080 Draft 起票 + roadmap update                                       |
| `72d1f88` | Phase 1            | `<Link>` + `<Frame>` JSX component (= packages/hibana/src/{link,frame}.ts) |
| `dc79f5c` | Phase 2            | client intercept + 最深 Frame swap (= 同 layout 内 navigation)             |
| `0469b5e` | Phase 3            | server header (X-Hibana-Layouts/Title) + partial HTML response             |
| `e1b6ee8` | Phase 3 fix        | X-Hibana-Title/Layouts encodeURIComponent (= ByteString 制約) + dogfood 1  |
| `7bcf5e1` | Phase 4            | 共通祖先計算 + layout 切り替え対応 (= persistent nested layout)            |
| `d5b7d6d` | Phase 5            | popstate + scroll restoration (sessionStorage) + dev warning               |
| `8f351fd` | Phase 6            | filesystem-based 版 dogfood (= apps/hibana-demo-fs) で中立性実証           |
| `47b9d1d` | Phase 7 review fix | C-1 並行 navigation race (AbortController) + C-2 null fallback (= 0)       |
| `b64af9b` | Phase 7 Accepted   | ADR Status: Draft → Accepted + roadmap 全 ✓ + memory update                |

依存: ADR 0079 (per-route head) = navigation 後の `<head>` 更新で merge ルール再利用
関連: [[project_hibana_step5_design]], [[project_hibana_overview]], [[project_html_first_wire]], [[project_legibility_test]], [[feedback_dx_first_design]], [[project_design_north_star]], [[project_hibana_layout_direction_pending]]

## Context

backend-first FW として default は MPA = リンククリックで:

- full page reload (= ブラウザ遷移、JS engine 死亡)
- white flash
- scroll 位置リセット
- island state 消失 (= Counter island の count: 5 → 0 にリセット)
- video 再生中断、CSS animation 中断、focus 状態消失

Hibana の identity = **MPA を base に "書いた分だけ" で SPA 風 navigation に進化させる** (= "引き算のデザイン" + "graceful degradation"、第 22 周目 user 発言で言語化)。実現方法 = client JS が `<a>` click を intercept、fetch で次 page を取得、必要部分だけ swap、island は teardown + re-hydrate。

業界先行例:

| FW                     | intercept                        | wire                | swap           |
| ---------------------- | -------------------------------- | ------------------- | -------------- |
| Turbo (Hotwire)        | 全 `<a>` 自動                    | full HTML           | body 全体      |
| HTMX                   | `hx-boost` opt-in                | partial HTML        | selector       |
| Astro View Transitions | `<ClientRouter>` で全 `<a>` 自動 | full HTML + diff    | body + persist |
| Inertia                | `<Link>` 明示                    | JSON tree           | component tree |
| React Router / Remix   | `<Link>` 明示 (SPA 前提)         | (no SSR navigation) | nested route   |

Hibana の制約:

- **MPA ベース** (= SPA 前提 FW の `<Link>` 哲学とは前提が違う)
- **cursor-based hydration + virtual DOM 不在** (= JSON tree wire は構造的に不可、memory [[project_jsx_transform_mandatory_for_hydrate]])
- **HTML-first wire** (memory [[project_html_first_wire]])
- **"書いた分だけ FW 機能が乗る" 哲学** (= 第 22 周目 user 発言、Hibana 他機構 island/layout/metadata と統一)
- **graceful degradation** (= 書き忘れ許容、JS 切れても劣化動作で壊れない)

これらを満たす 4 軸 (= intercept / wire / boundary marker / 共通祖先計算) を本 ADR で確定する。memory [[feedback_dx_first_design]] に従い target syntax を起点に逆引きで設計、第 22 周目 73rd session で user との設計議論経由で確定。

## Options

### 軸 1: intercept の引き金 (= どの `<a>` を hijack するか)

#### 軸 1-案 A: 全 `<a>` 自動 boost

書く側は何もしない、`<a>` が default で boost。Turbo / Astro 流。

**却下** — Hibana 他機構 (island / layout / metadata) は全て「明示的に何か書いた時だけ効く」(= `.island.tsx` 拡張子 / `hibanaLayout(L)` 呼び出し / `export const metadata`)。`<a>` 自動 boost は 1 機構だけ "default ON" になり、user 哲学 "書いた分だけ" と Hibana 内対称性に反する。external link 自動判定 (same-origin check) や `target="_blank"` 等の特殊 attr との相互作用も増える。

#### 軸 1-案 B: `<Link>` component (= 採用)

```tsx
import { Link } from "@vidro/hibana";
<Link href="/posts/2">記事 2</Link>      // FW 機能 opt-in、SPA 風 navigation
<a href="https://external.com">外部</a>  // 素の <a>、MPA 遷移
<a href="/posts/2">書き忘れ</a>          // 素の <a>、graceful degradation で MPA 動作
```

**採用**。理由:

- **"書いた分だけ" 整合** = Hibana 他機構と統一、書く = 明示 opt-in
- **graceful degradation** = `<Link>` 書き忘れ → 素の `<a>` で MPA 遷移、壊れない
- **React Router / Remix familiarity** = `<Link>` import + `href` props で書き味が既知
- **legibility test** (memory [[project_legibility_test]]) = 読んで「これ Link なので SPA 風 navigation する」と訳せる

cons:

- 書き忘れリスク (= 内部リンクなのに素の `<a>`) = ただし graceful degradation で MPA 動作する、壊れない
- internal/external link の判別を user が頭で判断 = React Router 等と同じ業界 default cost

#### 軸 1-案 C: `data-hibana-boost` attribute opt-in (HTMX 流)

**却下** — HTML 純度は高いが書く量増、`<Link>` の familiarity に劣る、Hibana の component API (= Frame と統一) と非整合。

### 軸 2: wire format (= server が何を返すか)

#### 軸 2-案 A: full HTML

`<html><head>...</head><body>...</body></html>` まるごと fetch、client は body 全体 or diff で差し替え。Turbo / Astro 流。

**却下** — `<Link>` の存在意義 = 最大限の最適化 (= 73rd session user 発言)。JS 切れ対応は素の `<a>` で十分、`<Link>` を使う = SPA 風最適化を user が明示意図。共通 layout を毎回 fetch するのは無駄で、`<Link>` の意味が薄まる。

#### 軸 2-案 B: partial HTML (= 採用)

最深 page の HTML 片だけを response body に返す、layout 部分は含めない。HTTP response header で layout stack を別 channel で送る。

**採用**。理由:

- **`<Link>` の存在意義 = 最適化** と整合 = 必要部分だけ wire で送る
- **HTML-first 整合** (memory [[project_html_first_wire]]) = JSON tree じゃない
- **cursor-based hydration model 整合** = innerHTML 的差し替えがそのまま動く、virtual DOM 不要

cons:

- wire format spec が必要 = `Accept: text/html;hibana-partial` 等の switch + `X-Hibana-Layouts` 等の header
- partial endpoint と full endpoint を共通 URL で兼用、Accept header / 内部 marker で switch

#### 軸 2-案 C: JSON tree (Inertia 流)

**却下** — JSON tree wire は client 側に virtual DOM + diff engine + component registry が必要 (= Inertia は React/Vue が virtual DOM 提供)。Hibana は virtual DOM 不在の cursor-based hydration なので **構造的に不可**。HTML-first 哲学 (memory [[project_html_first_wire]]) とも逆。

### 軸 3: boundary marker (= 何を swap するか識別)

#### 軸 3-案 A: 全 layout 全体 swap (= MVP)

layout も page も全部 fetch + swap、ただし layout の DOM は同一 layout 間 navigation では reuse。

**却下** — 「同一 layout 判定」のコストが結局必要、layout 全体 fetch なら案 2-A (full HTML) と区別がつかない。"書いた分だけ" 最適化と逆。

#### 軸 3-案 B: `<Outlet />` self-closing (React Router 流)

```tsx
export function PostsLayout() {
  // children prop 受け取らない
  return (
    <div>
      <Outlet />
    </div>
  ); // 子 page は FW が暗黙流し込み
}
```

**却下** — 既存 Hibana `LayoutComponent({ children }) => Node` API から breaking change (= children prop 削除)、書き忘れで page 完全表示されない (= graceful degradation 違反)、context magic で children の出所が読みにくい (= legibility test 微妙)。

#### 軸 3-案 C: `<Frame>{children}</Frame>` wrapper (= 採用)

```tsx
import { Frame } from "@vidro/hibana";
export function PostsLayout({ children }: { children: Node }) {
  return (
    <div>
      <aside>サイドバー</aside>
      <main>
        <Frame>{children}</Frame> // 「ここが page スロット」marker
      </main>
    </div>
  );
}
```

server render 時に `<Frame>` が `<hibana-frame data-layout="PostsLayout">` を吐き、client は cursor で marker を find + 中身を swap。

**採用**。理由:

- **既存 API 完全互換** = `LayoutComponent({ children }) => Node` のまま、breaking change ゼロ
- **graceful degradation** = `<Frame>` 書き忘れ = swap marker 消えるだけ、page 自体は children として render される (= 書き忘れても壊れない)
- **legibility test 通る** = `<Frame>{children}</Frame>` を読んで「子要素を Frame で囲んで boundary marker 付ける」と訳せる
- **"書いた分だけ" 整合** = `<Frame>` を書いた layout だけ partial swap 対応、書かなければ full reload fallback
- **handler-based / filesystem-based 両対応** = layout 機構の本採用判断 (= ADR 0081 持ち越し) に neutral

cons:

- 書き忘れで partial swap 効かない = dev warning でカバー (= silent fallback はしない、明示警告)

### 軸 3.b: 命名 — Frame vs Outlet vs Slot

**Frame 採用**。理由:

- **炎系命名一貫性**: Hibana = 火花 + Hono = 炎 + **Frame ≒ Flame** = 炎。Hibana FW 機構として "炎系の言葉" で統一する命名遊び (= 第 22 周目 user 発見)
- Outlet = React Router familiarity あるが self-closing 形式で軸 3-案 B と組になる、`<Frame>{children}</Frame>` 採用なら不適合
- Slot = Web Components 流、Vue / Svelte 既出語彙だが意味の指向が違う (= 任意 children 投入口 vs page boundary marker)

### 軸 4: 共通祖先計算 (= layout 切り替え navigation 時の挙動)

シナリオ: `/posts` → `/about` 遷移で `AppLayout > PostsLayout > Frame(PostListPage)` から `AppLayout > AboutLayout > Frame(AboutPage)` に変わる場合。

#### 軸 4-案 A: MVP — 最深 Frame だけ swap、layout 切り替え時は full reload

同 layout 内 (= `/posts/1` → `/posts/2`) は partial swap、layout 切り替え (= `/posts` → `/about`) は full reload。

**却下** — `<Link>` の存在意義 = 最大限の最適化と逆。layout 切り替え時に white flash + state 消失が出るのは "FW 価値" を半分捨てる。

#### 軸 4-案 B: server response header `X-Hibana-Layouts` (= 採用)

```
GET /about  Accept: text/html;hibana-partial
→ 200, X-Hibana-Layouts: AppLayout,AboutLayout
  <partial HTML for innermost Frame>
```

client は現 DOM の `<hibana-frame data-layout="...">` stack と response header の新 stack を比較、**共通祖先以下を swap**。

**採用**。理由:

- **layout 機構の本採用判断に中立** = handler-based / filesystem-based 両対応
- **業界 default** = Remix / Inertia の persistent layouts 流
- **段階的最適化余地** = filesystem-based 採用なら将来 Approach C (URL 計算) で最適化可能

cons:

- 共通祖先計算 logic が要る (= layout stack 比較 + 共通 prefix 計算 + 共通祖先以下を swap)
- server から layout name list を取得する必要 (= handler-based なら `c.var.hibanaLayouts` から取れる、filesystem-based なら `_renderer.tsx` 階層から取れる)

#### 軸 4-案 C: URL-based layout 計算 (filesystem-based 専用)

filesystem-based なら URL → layout stack を client が server 問い合わせなしで計算可能 (= filesystem 規約に従って `_renderer.tsx` の階層が決定論的)。prefetch も楽。

**保留** (= 将来最適化余地)。理由:

- handler-based では構造的に不可 (= layout は middleware chain で動的に決まる)
- 現在 ADR 0081 (= 旧 0080) で handler vs filesystem 本採用判断は保留中、案 C を採用すると ADR 0081 を **filesystem-based 採用に縛る**
- 案 B で両対応してから、ADR 0081 で filesystem-based 採用なら案 C で再最適化、handler-based 採用なら案 B のまま、という段階戦略 (= 詳細 [[project_hibana_step5_design]])

## Decision

**`<Link>` + partial HTML + `<Frame>{children}</Frame>` + Approach B (server header `X-Hibana-Layouts`)** で確定。

### API shape

```ts
// @vidro/hibana から export
export { Link, Frame } from "...";

type LinkProps = {
  href: string;
  children: Node;
  // 将来拡張余地: prefetch, replace, scroll 等
};

type FrameProps = {
  children: Node;
  // 将来拡張余地: transition, persist 等
};
```

### Wire spec (= server ⟷ client contract)

**リクエスト**:

```
GET /posts/2
Accept: text/html;hibana-partial
```

**レスポンス**:

```
HTTP/1.1 200 OK
X-Hibana-Layouts: AppLayout,PostsLayout
Content-Type: text/html

<partial HTML for innermost Frame>
<h1>Post 2</h1>
<p>...</p>
```

通常の MPA リクエスト (= `Accept: text/html` 等) は **full HTML** を返す (= 兼用 endpoint、graceful degradation で JS 切れも素の `<a>` が動く)。

### 機構

1. **`<Link>` JSX component** (`packages/hibana/src/link.tsx`):
   - `<a href data-hibana-link>{children}</a>` を render
   - server render 時に `data-hibana-link` 属性付き

2. **`<Frame>` JSX component** (`packages/hibana/src/frame.tsx`):
   - `<hibana-frame data-layout="...">{children}</hibana-frame>` を render
   - `data-layout` は server から渡される現 layout name (= handler-based なら `c.var.hibanaLayouts` の最深 entry、filesystem-based なら `_renderer.tsx` の階層情報)

3. **client navigation runtime** (`packages/hibana/src/client-navigation.ts`):
   - document.addEventListener("click") で `[data-hibana-link]` 検出
   - preventDefault + history.pushState + fetch with `Accept: text/html;hibana-partial`
   - response の `X-Hibana-Layouts` header と現 DOM `<hibana-frame data-layout="...">` stack を比較
   - 共通祖先以下を innerHTML で差し替え + new islands re-hydrate + old islands teardown
   - popstate listener で back/forward 対応

4. **server header attachment** (`packages/hibana/src/index.ts` の renderer):
   - `Accept: text/html;hibana-partial` を検出
   - 検出時: layout chain skip して最深 page のみ render + `X-Hibana-Layouts` header 付与
   - 非検出時: 既存 full HTML response (= MPA 兼用)

5. **dev warning** (Vite plugin transform):
   - layout component (= `_renderer.tsx` or `hibanaLayout(L)` 経由 component) が `<Frame>` を含まない場合、console.warn + dev overlay

### Phase 分割 (= 実装計画、tasks #1-#8 と対応、全完走)

| Phase   | 内容                                                                        | 状態 |
| ------- | --------------------------------------------------------------------------- | ---- |
| Phase 0 | 設計 doc + roadmap update + ADR 0080 起票 (Draft)                           | ✓    |
| Phase 1 | Link + Frame JSX component 実装 (`<a data-hibana-link>` + `<hibana-frame>`) | ✓    |
| Phase 2 | client intercept + 最深 Frame swap (= 同 layout 内 navigation 対応)         | ✓    |
| Phase 3 | server header + partial HTML response                                       | ✓    |
| Phase 4 | client 共通祖先計算 + layout 切り替え対応                                   | ✓    |
| Phase 5 | dev warning + scroll restoration + popstate                                 | ✓    |
| Phase 6 | dogfood (apps/hibana-demo + apps/hibana-demo-fs 両方 + Playwright smoke)    | ✓    |
| Phase 7 | code-reviewer Critical 2 件 fix + ADR Accepted 昇格 + memory update         | ✓    |

## Consequences

### 良くなること

- **MPA → SPA 風 UX** = `<Link>` で navigate すると white flash なし、scroll 維持、island state 維持
- **wire 最小化** = partial HTML で必要部分だけ送る、layout 共通部は毎回再送しない
- **書く側の認知負荷小** = `<Link>` + `<Frame>` 2 個だけ覚えれば書ける
- **graceful degradation** = `<Link>` / `<Frame>` 書き忘れ + JS 切れ全て劣化動作で壊れない
- **layout 機構に中立** = handler-based / filesystem-based どちらでも動く、ADR 0081 (= 旧 0080) の本採用判断を妨げない
- **段階的最適化余地** = filesystem-based 採用時に Approach C (URL 計算) で server 問い合わせなしの prefetch / navigate 可能
- **炎系命名一貫性** = Hibana / Hono / Frame の 3 語彙で FW identity を視覚化 (= 第 22 周目 user 発見)

### Trade-off / 持ち越し

- **wire spec が増える** = `Accept: text/html;hibana-partial` + `X-Hibana-Layouts` header の規定、ただし MPA 兼用 endpoint なので分かりやすい
- **共通祖先計算 logic** = client runtime に layout stack 比較ロジック、bundle size 増 (= ただし軽量、~1KB 想定)
- **Frame 書き忘れ** = partial swap 効かないだけ (= graceful degradation で page は表示される)、dev warning でカバー
- **layout 識別の信頼性** = `data-layout="..."` は server から source-of-truth として渡されるべき、client から推測しない (= filesystem-based / handler-based で source が違うので server 経由が安全)
- **prefetch 未対応 (v1)** = `<Link>` の hover prefetch / viewport prefetch は v1 では skip、dogfood で困ったら v2 で追加
- **transition 効果未対応 (v1)** = View Transitions API 統合は v1 では skip、`<Frame>` の prop に余地は残す
- **layout 名 minify 縮退リスク** (= Phase 7 review I-1) = `data-layout` は `LayoutComponent.name` から付与しているため、prod minify で関数名が縮退すると **異なる layout が同名で誤 match** する可能性がある。現状 prod build 未検証、minify ON にする時に再評価 (= 候補対応 = `Object.defineProperty(L, "name", ...)` で固定 / `<Frame>` に `name` prop 明示 / build plugin で自動付与)
- **dev warning が partial mode で発火しない** (= Phase 7 review I-2) = Vite plugin の dev warning は full HTML response (= 初回 / リロード経路) の `<hibana-frame` 出現数で判定しており、`<Link>` 経由 partial response の path には適用されない。`<Link>` 経由で初めて踏む layout の Frame 書き忘れは silent (= partial swap が効かず full reload fallback で動作はする)。dogfood で見落としが起きたら partial 経路にも警告を追加

### 拡張余地 (= 将来 ADR or dogfood trigger)

- **`<Link>` prefetch** = `prefetch="hover" | "viewport" | "load"` prop で prefetch 制御、dogfood で navigate latency が体感されたら起票
- **`<Frame>` transition** = View Transitions API 統合 (= `transition="slide" | "fade"` 等)、UX 改善で起票
- **`<Frame>` persist** = navigate 中も state を保持する mode (= 例えば audio player layout)、dogfood で要望出たら起票
- **Approach C** (URL 計算最適化) = ADR 0081 (layout 機構本採用判断) で filesystem-based 採用なら起票
- **island state 引き継ぎ** = 同 island が navigate 前後に存在する場合 state を保持、Inertia の persistent layouts 流、dogfood で痛みが出たら
- **scroll restoration policy** = navigate 時 top reset / position keep の opt-in、`<Link scroll="top" | "keep">` prop 等

## 関連

- [[project_hibana_step5_design]] = 第 22 周目 73rd session で確定した 4 軸詳細
- [[project_hibana_overview]] = Hibana 全体像
- [[project_html_first_wire]] = wire format 哲学
- [[project_legibility_test]] = magic 許容基準
- [[feedback_dx_first_design]] = target syntax 起点設計
- [[project_design_north_star]] = RSC simpler 代替
- [[project_hibana_layout_direction_pending]] = layout 機構本採用判断 ADR (= 0081 にずれた経緯)
- ADR 0079 = per-route head metadata (= `<head>` merge ロジックを navigation 後も適用)
- docs/roadmap-hibana.md = Step 5 該当
