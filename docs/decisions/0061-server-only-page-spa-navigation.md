# 0061 — Server-only page SPA navigation via partial HTML

## Status

**Accepted** — 2026-05-06 (55th session、議論完了 / user 合意取得 / reviewer agent finding 全件反映済 / 未着工)

依存: ADR 0058 (.server.tsx semantics)、ADR 0060 (partial hydration impl)、ADR 0017 (Router server mode)、ADR 0009 (layout-loader parallel fetch)、ADR 0035 (progressive hydration foundation)
関連: ADR 0057 (FW design stance)、ADR 0049 (loaderData primitive)、ADR 0052 (search params)

## Context

### ADR 0060 dogfood で見つかった「真っ白」問題

ADR 0060 Phase 2 で `.server.tsx` page は **client bundle 上で stub 化**される (= virtual module、本体 logic を削除)。これにより以下が成立:

- URL 直打ち (`/posts/1`) → server SSR → client は shell hydrate + island walker で内部の島だけ hydrate → **正常**
- `<Link href="/posts/1">` クリック → `navigate()` → effect 内で `match.route.load()` が **client bundle 上の stub module の `default()`** を呼ぶ → **stub なので空が返って真っ白**

Phase 2 着地時点で `.server.tsx` の SPA navigation は機能しない状態。

### なぜ伝統的 SSR FW の解法が使えないか

| FW                   | server-only component  | SPA navigation の wire                                                                                                     |
| -------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Remix / SolidStart   | 無い (両側 render)     | JSON で loader 結果 + client component で再 render                                                                         |
| Next.js App Router   | 有り                   | RSC Payload (Flight) で element tree シリアライズ                                                                          |
| Astro Server Islands | 有り                   | default は MPA (full reload)、`<ViewTransitions>` 併用で SPA-like 化可能 (= ただし Server Islands の hydrate は個別 fetch) |
| **Vidro**            | 有り (= ADR 0058/0060) | **未定 (= 本 ADR で decide)**                                                                                              |

伝統的 SSR FW (Remix 等) の「JSON で data fetch → client component で render」は **component が両側 bundle に居る** 前提で成立する。`.server.tsx` の component が client bundle に居ない (= ADR 0060 の bundle 削減効果) Vidro では JSON wire は **構造的に不可能**。

→ **server で render 済みの結果を送る**しかない。RSC は Flight、Vidro は HTML-first philosophy (memory `project_html_first_wire`) と整合する **partial HTML wire** を採用。

### 北極星との接続

memory `project_design_north_star` / `project_vidro_rsc_like_core_model` で「invoke-once + signal が Flight を不要にする」「HTML-first wire format」が確定済。本 ADR は北極星の navigation 経路への適用 (= ADR 0060 が初回 SSR/hydrate 経路、本 ADR が SPA navigation 経路)。

### 既存 FW との対比

| 項目                   | Vidro                | Next.js App Router              | Hotwire Turbo    | htmx         |
| ---------------------- | -------------------- | ------------------------------- | ---------------- | ------------ |
| navigation wire        | partial HTML         | RSC Payload (Flight)            | partial HTML     | partial HTML |
| layout boundary aware  | ✅ (= 本 ADR で)     | ✅ (= segment tree diff)        | ⚠️ frame id 単位 | ⚠️ user 指定 |
| client が現 state 送信 | pathname のみ        | router state tree               | frame id         | hx-target    |
| state tree encoding    | 不要 (server で導出) | 必要 (`Next-Router-State-Tree`) | 不要             | 不要         |

→ **Next App Router の layout boundary aware design を canonical reference にしつつ、HTML-first + state tree 不要で simpler 化**。

## Options

### A. Endpoint shape (= partial response の wire 配線)

#### A-α: 別 endpoint で分離 (= 採用案)

```
GET /__partial?to=/posts/1
→ 200 application/x-vidro-partial+html (or text/html)
   <body of partial fragment>
```

既存 `/__loader` (= ADR 0009) と対称な internal infrastructure endpoint。

メリット:

- `/__loader` と対称 = 学習コスト低 (= Vidro 内 mental model 整合)
- CDN cache の `Vary` header 設計が不要 (= partial endpoint と通常 endpoint で完全分離)
- `curl /__partial?to=/posts/1` で直接 debug 可能 (= header 操作不要)
- middleware の意図しない適用を避けられる (= partial 経路と user-facing 経路を分離)

デメリット:

- 派生 URL ができる (= REST URL 正規性が崩れる)
- direct hit (bot / mistype) 時の挙動を別途定義する必要あり (= 普通に partial fragment を返す = 壊れない)

#### A-β: content negotiation (= Next.js 流)

同 URL `/posts/1` に header (`X-Vidro-Partial: 1` 等) で形式切替。

メリット:

- REST URL 正規性 (= URL 1 つ = リソース 1 つ)
- CDN edge prefetch 親和性 (= 同 URL を pre-warm 可能)
- middleware が URL ベースで自動適用 (= partial 経路への個別 bind 不要)

デメリット:

- `Vary` header と CDN cache 設計が複雑化
- 既存 `/__loader` と非対称 (= 内部 mental model が割れる)

#### 採用理由

Vidro 規模 (= toy / hobby / cf、memory `project_design_north_star`) では A-β の優位点 (= CDN edge cache, middleware chain) が効かない。`/__loader` との対称性 + cache 設計の単純さで A-α 採用。

#### Future migration

A-α → A-β は技術的に可能。**partial render を pure 関数 `renderPartialHTML(from, to)` として server-side で分離**しておけば、wire 部分の差替えコストは小さい。ただし **完全な「shim」ではない** (= reviewer W-2 反映): response の `divergeIndex` 情報を query / body / header のどこに載せるかが変わるため、wire schema 自体の調整が必要。internal protocol なので user code には影響しないが、client / server 双方の wire 解釈ロジックは触る。

移行 trigger:

- CDN edge cache を本格化したい
- middleware chain 拡大で `/__partial` への個別 bind が漏れリスクになる
- bot 経由の internal endpoint 漏れが SEO 等で困る

移行手順:

1. server: `/posts/1` に header 経路を追加 (= 既存 `renderPartialHTML` 関数を流用、wire 層だけ追加)
2. response shape decide (= `X-Vidro-Diverge-Index` header に divergeIndex を移す等)
3. client: `navigate()` の fetch 先を `/__partial?to=...` から `/posts/1` + header に切替、divergeIndex 取得経路を header に変更
4. `/__partial` を deprecate

### B. Partial fragment の boundary 単位

#### B-α: leaf page だけ送る

server は new pathname の leaf page だけ render → HTML fragment。client は leaf 領域だけ swap、layout は触らない。

致命傷: layout が変わる navigation (例: `/posts/1` → `/users/1`) で **layout chain が壊れる** (= `/posts/layout.tsx` の中に `/users` の page が入る)。回避するには「layout 変更判定 → 別経路」が要る = 結局 B-β のロジックが必要 → **採用不可**。

#### B-β: 共通 layout 以下を 1 fragment にまとめて送る (= 採用案)

```
client request:  GET /__partial?to=/posts/2&from=/posts/1
server:
  1. compileRoutes から from / to の layout chain 計算
     from: [root layout, posts layout, post page]
     to:   [root layout, posts layout, post page (id=2)]
  2. 共通 prefix (= [root layout, posts layout]) を skip
  3. 変わる layer (= leaf post page) 以下を foldRouteTree で render
  4. partial HTML fragment + 変わる layer index N を返す
client:
  - 既存の layer N の DOM range を swap
  - 共通 prefix (root + posts layout) はそのまま
```

メリット:

- layout state 保持 (= sidebar scroll / focus / signal が生き残る)
- 最小データ転送
- Next App Router 流で canonical

デメリット:

- 実装中規模 (= layer 単位の DOM range 管理が必要)

#### B-γ: 変わる layer 群を個別 fragment 列で送る

各 layer を個別 HTML fragment にして配列で送り、client が layer 単位で個別 swap。

メリット:

- streaming で layer 単位段階 paint 可能
- layer 個別 cache TTL / prefetch 可能
- layer 個別 error 復旧

デメリット:

- complexity 増 (= server response shape が配列、client swap が layer ループ)
- Vidro 規模で要らない (= streaming 段階 paint や layer 単位 cache の要求が薄い)

#### 採用理由

B-α は不採用 (= 致命傷)。B-β が canonical で Vidro 規模に最適。B-γ は overkill。

#### Future migration

B-β → B-γ は **wire format 変更 (= breaking)** だが internal protocol なので user code に影響しない。endpoint version up (`/__partial/v2`) で移行可能。

B-β 実装時に **layer 単位の DOM range 管理**を入れておけば、B-γ 移行は wire 差替えのみ。

移行 trigger:

- streaming SSR の段階 paint 要求
- layer 個別 cache 戦略 / prefetch
- layer 単位 error 復旧

### C. Island hydrate after navigation

#### C-α: swap range 限定 walker (= 採用案)

partial fragment swap 後、**変わった layer N の DOM range だけ** walker 走査して island を hydrate。既存の `hydrateRange` API (= ADR 0035 boundary 単位 hydrate と共用) を流用。

メリット:

- range 限定で効率的
- 既存機構流用 (= 新 API 不要)
- B-β で layer N の DOM range 管理を持ってる前提と整合

#### C-β: boot walker 全再実行

navigation 後に setupIslandHydration の walker を全 page でもう一度実行、既 hydrate marker は idempotent skip。

デメリット: 全 walk コスト + idempotent 化の追加実装が必要。

#### C-γ: registry listening (push-based)

`__vidroIslandHydrate` registry を listening にして、新規 push されたら自動 hydrate。

デメリット: 新 mental model、overkill。

#### 採用理由

B-β 実装時に layer N の DOM range が手元にあるので、C-α が一番自然 + 流用機構が揃ってる。

**前提条件 (= reviewer M-2 反映)**: eagerModules が boot 時に **`import.meta.glob('./routes/**/\*.{ts,tsx}', { eager: true })`で全 routes を一括 glob してる**こと。これによって navigation 先の新`.server.tsx` も eager map に含まれており、island lookup が成立する。partial swap で旧 layer N の island を dispose する cleanup 経路 (= ADR 0060 既知の Owner leak と同論点) は本 ADR の範囲外、Phase 3 dogfood で踏んだら別途 fix。

### D. 補助的決定 (= A-α / B-β / C-α 採用で自然に決まる)

#### D-1. per-render seq counter scope

server で partial render する時も `runWithIslandScope` (= ADR 0060 で確立) 内で render → seq counter は per-request reset、name collision なし。

#### D-2. registry namespace + push hook 経路の使い分け (= reviewer M-3 反映)

`__vidroIslandHydrate` queue を namespace としては流用 (= boot 経路と navigation 経路で同 queue / 同 marker shape)。

ただし **navigation 経路では push hook (= 即時 hydrate) には頼らない**。理由は ADR 0060 の `setupIslandHydration` の push hook が「DOM に挿入済」前提で `findMarkerRange` を walk するため、partial swap **完了前** に server 側の inline `<script>` から push が発火すると DOM 不在で `console.warn` を吐いて終わる競合があるため。

採用経路: **swap 完了後に明示的に range walker (= `hydrateRange(rangeStart, rangeEnd)` 相当) を呼ぶ**。push hook は boot 経路 + 後着 island chunk の遅着 race のためだけに保持。

#### D-3. island module 解決

eagerModules ベースの global map (= ADR 0060 で確立、`.server.tsx` 全部の `__islands` を集めた map) をそのまま流用。前提 (= 全 routes eager glob) は C-α と同じ。

### E. `/__partial` で `from` 不在時の挙動

#### E-α: 400 Bad Request (= 採用案)

server: `from` query が無いまたは空なら 400 を返す。`from` は必須 param。

client: navigate() / popstate 経路で **必ず `from` (= currentPathname の現在値) を送る** ことを保証。dev mode で send 直前に `from` 不在チェック → console.warn (= safety net、bug 検知)。

#### E-β: 全 layer 再 render の partial fragment

server: `commonPrefixLen=0` の特殊ケースとして全 layer を render した partial fragment を返す。

#### E-γ: full HTML response (= 通常 SSR と同等)

server: full `<html>...</html>` を返す。client は content-type で partial / full を判定。

#### 採用理由

`/__partial` は internal infrastructure endpoint で、user 操作経路では `from` 不在は発生しない (= URL 直打ち / bookmark / external link は通常 `/posts/1` GET に来る、`<Link>` / popstate は client が currentPathname signal で必ず `from` を保持)。`from` 不在の shadow case は **bot crawl / curl 直叩き / client bug** のみ。

E-α (400) は最 simpler で client bug 検知も容易。E-β は `from` 送り忘れ bug を隠す副作用あり。E-γ は wire format ambiguity を生み、A-α (endpoint 分離) の意義を弱める。

副次決定:

- robots.txt に `Disallow: /__partial` を追加 (= bot crawl による 400 noise 回避)
- client は dev mode で `from` 不在を console.warn (= bug 早期検知 safety net)

### F. Error response shape

#### F-α: status code + 最小 body (= 採用案)

server: 4xx/5xx は **status code を見て判断、body は text 1 行 / 空**。infrastructure error 専用。

client: `res.ok === false` なら `window.location.assign(href)` で full reload。

application error (= loader / render error) は **200 経路に集約**:

- server-side `foldRouteTree` 内の ErrorBoundary が階層的 error.tsx を render
- partial fragment に error.tsx の HTML が乗って返る (= 200)
- client は normal swap = error 表示が出る

#### F-β: JSON body で error 詳細 (= `/__loader` 流)

server: 4xx/5xx で `{ error: { name, message, stack } }` を JSON で返す。

デメリット: partial endpoint で wire format が 2 重 (= HTML + JSON)、A-α (endpoint 分離) の意義を弱める。

#### F-γ: error.tsx HTML fragment を返す

server: 4xx/5xx で error.tsx の partial HTML を返す → client は swap。

デメリット: infrastructure error (= server crash) と application error (= loader 失敗) の責務が混じる、client が状態を信用できない場面 (= server crash) で swap するのは危険。

#### 採用理由

application error は 200 経路 + error.tsx で吸収済 (= ADR 0009/0010 と整合)。残る 4xx/5xx は infrastructure error 専用 → client は状態を信用できない → 一番安全な full reload に倒す。F-α が simpler。

副次決定:

- error 種類 (= status code) ごとの client 挙動は full reload で統一 (= 4xx/5xx の細分は不要)
- network failure (= fetch 自体 reject) も同 pattern で full reload
- application error (= loader / render error) は server-side で **200 + error.tsx 入り partial HTML** に倒す

### G. Search params encoding

#### G-α: `to` / `from` に `pathname + search` を encodeURIComponent (= 採用案)

```
client (navigate 発火時):
  // toPath は <Link href="..."> 等で渡された遷移先 (search 含む or 含まない)
  // fromSearch は navigate() 同期実行で window.location.search を取る (= race なし)
  const fromSearch = window.location.search;  // pathname 側は currentPathname.value
  /__partial?to=${encodeURIComponent(toPath)}
            &from=${encodeURIComponent(currentPathname.value + fromSearch)}

server:
  const toRaw = url.searchParams.get("to") ?? "";
  const toUrl = new URL(toRaw, "http://_");  // host は dummy
  const toPathname = toUrl.pathname;
  const toSearch = toUrl.search;
```

`fromSearch` の取得元: navigate() / popstate handler は **同期実行**なので、`window.location.search` を発火直前に読めば race は発生しない。`currentPathname` signal は pathname のみ保持 (= ADR 0052 で確立) なので、search は location 直読みで補う。将来 `currentPathnameWithSearch` を新設する経路もあり得るが、本 ADR では最小変更で進める (= 必要になったら別 ADR)。

メリット:

- URL encoding 標準 = browser / server で素直
- `from` にも対称適用 (= 同 pattern)
- query 数最小 (= `to` + `from` の 2 つだけ)

#### G-β: `to` (pathname のみ) と `toSearch` を別 query で分離

メリット: server 側 parse 不要。

デメリット: query 数増 (= `to` / `toSearch` / `from` / `fromSearch`)、Vidro mental model 増。

#### G-γ: full URL 形式で送る (= `to=https://host/posts/1?page=2`)

デメリット: host が無意味、なぜ含むかの説明が必要。

#### 採用理由

URL encoding の 2 重化は browser / server で標準対応 (= `encodeURIComponent` / `new URL(decoded, "http://_")`)。`from` への対称適用 + query 数最小で G-α 採用。

## Decision

| 軸                  | 採用                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------ |
| (A) endpoint        | **A-α**: `/__partial?to=<pathname>&from=<pathname>` で別 endpoint                                            |
| (B) boundary 単位   | **B-β**: 共通 layout 以下を 1 fragment にまとめて送る                                                        |
| (C) island hydrate  | **C-α**: swap range 限定 walker (= `hydrateRange` 流用)                                                      |
| (E) `from` 不在時   | **E-α**: server は 400 / client は必ず `from` 送る                                                           |
| (F) error response  | **F-α**: 4xx/5xx は status + 最小 body / client は full reload (application error は 200 + error.tsx に集約) |
| (G) search encoding | **G-α**: `to`/`from` に `pathname + search` を encodeURIComponent                                            |

## Consequences

### Pros

1. **`.server.tsx` の SPA navigation が成立** = MPA full reload に倒さずに、layout state を保ったまま遷移可能
2. **HTML-first wire の simpler 化が navigation 経路にも一貫適用** = Flight / segment tree encoding 不要
3. **既存機構 (`/__loader` / `hydrateRange` / `runWithIslandScope`) を流用** = 新規 primitive 最小
4. **将来 X / B-γ への移行余地を残す** = 規模拡大時に切替可能 (= 上記 Future migration セクション)

### Cons / Trade-offs

1. **layer 単位の DOM range 管理** が router.tsx に必要 = 現状 `currentNodes: Node[]` を **layer index N の Map に拡張**
2. **partial render endpoint 追加** = server-side で `renderPartialHTML(from, to)` 関数 + Vite plugin or createServerHandler 配線
3. **partial endpoint の direct hit 挙動** = bot / mistype で `/__partial?to=/posts/1` が叩かれても壊れないよう、isolated fragment を返す設計

### YAGNI (= 本 ADR では入れない)

- partial fragment の **prefetch** (= `<Link>` hover で先読み)
- **scroll restoration** (= 戻る/進む時の scroll 位置復元)
- **streaming partial response** (= 段階 paint、B-γ と密結合)
- **layer 個別 cache** (= 同上)

これらは別 ADR で議論。

## Implementation Plan

### Phase 1: server-side partial render

1. `compileRoutes` の結果から `from` / `to` の layout chain を計算する pure 関数 `diffLayoutChain(from, to, compiled): { commonPrefixLen, divergeIndex }` を route-tree.ts に追加
2. **`foldRouteTree` 拡張 or 専用関数分離 (= reviewer M-1 反映)**: 現状の `foldRouteTree` (router.tsx) は full chain 前提。partial 用の経路として以下のいずれかで分離する:
   - 案 a: `foldRouteTree(input, options?: { startIdx })` で先頭 N layer skip 引数を追加
   - 案 b: 専用関数 `foldPartialRouteTree(input, startIdx)` として新設、共通部品は extract
   - **どちらにするかは Phase 1 着手時に decide** (= router.tsx の現状を読みながら判断、Open Questions に記録)
3. `renderPartialHTML(from, to, compiled, request): { html, divergeIndex }` を server-side に追加 (= 上記 fold 関数を使って divergeIndex 以降の subtree だけ render)
4. `/__partial` endpoint を createServerHandler または Vite plugin (server middleware) に配線、`from` 不在時は 400 (= E-α)、loader/render error は 200 + error.tsx 入り partial HTML (= F-α)

### Phase 2: client-side partial swap

1. **`foldRouteTree` が layer N の DOM range marker を expose する設計 (= reviewer C-1 反映)**: 現状 `foldRouteTree` は Node を返すだけで layer 単位の range marker 情報を呼び出し元に渡さない。以下の選択を Phase 1 完了後 / Phase 2 着手前に decide:
   - 案 a: `foldRouteTree` の戻り値を `{ node, layerRanges: Map<layerIdx, { start, end }> }` に変更
   - 案 b: `foldRouteTree` 内で module-scope の `layerRangesRegistry` に書き出し、呼び出し元が pull
   - **着手前に Open Questions と合わせて検討**
2. router.tsx の `currentNodes: Node[]` を `currentLayerRanges: Map<layerIdx, { start: Comment, end: Comment }>` に拡張、`swap()` 関数を「layer N の range だけ入れ替え」に書き換え
3. layer 単位の DOM range marker (= start/end Comment) を fold 時に挿入
4. navigate() で `from` (= `currentPathname.value + window.location.search`) を伝えて `/__partial` を fetch、partial HTML を取得
5. divergeIndex を見て該当 layer N の range を swap
6. swap 後に **range walker を明示的に呼んで island hydrate** (= reviewer M-3 反映、push hook 経由には頼らない)
7. **popstate handler の改修 (= reviewer W-5 反映)**: 現状の onPopState (router.tsx L.160-165) は `currentPathname.value` を更新するだけ。`.server.tsx` page から / への戻る/進むも `/__partial` 経路を通すように navigate() と同等の経路に統合
8. error 経路: `/__partial` が 4xx/5xx を返した場合 / fetch reject の場合 → `window.location.assign(href)` で full reload (= F-α)

### Phase 3: dogfood

1. `apps/router/src/routes/posts/[id]/index.server.tsx` (= ADR 0060 で追加済) に `<Link>` で別 post に遷移する経路を追加
2. browser で SPA navigation 確認 (= flash なし、layout 据置、island hydrate、re-click で count 独立動作)
3. layout が変わる navigation (= `/posts/1` → `/users/1`) でも layout 切替が走ることを確認
4. **popstate (戻る/進む) で同経路が動くことを確認** (= reviewer W-5)
5. **search params 付き navigation (= `/posts?page=2` → `/posts?page=3`、`/posts/1?from=list` 等) で `from` / `to` の search 部分が正しく往復することを確認** (= reviewer W-3)
6. **`apps/router/public/robots.txt` に `Disallow: /__partial` を追加** (= reviewer W-1)
7. error 経路 dogfood: `.server.tsx` page で意図的に loader throw → 200 + error.tsx 入り partial が swap される、`/__partial` が 5xx → full reload で復帰

### 工数見積

合計 **~400-500 行** (= reviewer 指摘の C-1/M-1 で fold 関数分離 / range marker expose の追加分込み)、ADR 1 サイクル (= 数日) 規模。

## Open Questions

Phase 1/2 着手前に decide する項目 (= reviewer C-1 / M-1 反映):

1. **Phase 1 着手時**: `foldRouteTree` の partial 化を **拡張引数 (案 a)** か **専用関数 `foldPartialRouteTree` (案 b)** か。判定材料は既存 `foldRouteTree` の責務膨張度と、partial 経路で skip すべき分岐 (loader error 時 layer 切捨て / wrapLayout の `children` getter 経路など) が共通部品として extract できるかを実装着手時に router.tsx で確認して decide。
2. **Phase 2 着手前**: `foldRouteTree` が layer N の DOM range marker (= start/end Comment) を **戻り値で返す (案 a)** か **module-scope registry に書き出して呼び出し元が pull (案 b)** か。案 a は signature 変更が広範、案 b は state の hidden global が増える、それぞれの trade-off で decide。
