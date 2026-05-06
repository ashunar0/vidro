# 0060 — Partial hydration: stub virtual module + island marker + selective hydrate

## Status

**Accepted** — 2026-05-06 (52nd session、議論完了 / user 合意取得 / reviewer agent finding 反映済)

**Phase 2 implementation landed** — 2026-05-06 (54th session、機構 A/B/C + dogfood + static span skip 機構を追加して end-to-end 完成)

依存: ADR 0058 (.server.tsx semantics)、ADR 0035 (progressive hydration foundation)、ADR 0030 (renderToStringAsync)、ADR 0027 (B-3d main hydrate)、ADR 0036 (TTI improvement)
関連: ADR 0057 (FW design stance)、ADR 0015 (Phase A bootstrap)
注: ADR 0058 文中で「ADR 0059 候補 = partial hydration」と予告したが、ADR 0059 は validation error primitive で先取り。partial hydration impl は ADR 0060 として起票。

## Context

### ADR 0058 を effective にする

ADR 0058 で `.server.tsx` の意味論 (= server-only component file、bundle 除外、両側実行 default) は decide した。だが code 変更ゼロで意味論定義のみだったため、現状は **「`.server.tsx` を書いても何も起きない」状態**。本 ADR で:

- `.server.tsx` を client bundle から除外する build pipeline
- 内部の Client Component (= island) を hydrate する runtime
- これらを実装して ADR 0058 の bundle 削減効果を **effective** に

### Vidro 北極星 (RSC simpler 代替) との接続

memory `project_design_north_star` / `project_vidro_rsc_like_core_model` 整理通り、Vidro が React RSC の simpler 代替となる構造的根拠は **invoke-once + signal が Flight を不要にする** こと。本 ADR は北極星の **具体実装**。

### 既存機構との接続

- **ADR 0035** で着地済の `__vidroPendingHydrate` registry / cursor / boundary 単位 hydrate を流用 (= 新規 registry 不要)
- **ADR 0030** で着地済の renderToStringAsync を default 化 (= `.server.tsx` の async 評価対応)
- **ADR 0036** で着地済の `__vidroBoot` trampoline で発火 (= bundle 先着 / 遅着の race 解消)
- **ADR 0027** で着地済の hydrate primitive を island 単位で呼び出す形に流用

### 既存 FW との対比

`project_vidro_rsc_like_core_model` の整理に加え、本 ADR の実装方針は既存 FW と整合:

| 項目                   | Vidro  | Astro     | SolidStart    | Next.js (RSC) | Qwik         |
| ---------------------- | ------ | --------- | ------------- | ------------- | ------------ |
| boundary marker        | 拡張子 | directive | 拡張子        | directive     | $            |
| stub / virtual module  | ✅     | ✅        | ✅            | (Flight)      | ✅           |
| HTML comment marker    | ✅     | ✅        | ✅            | ✅            | ✅           |
| registry-based hydrate | ✅     | ✅        | (cursor 直接) | (Flight tree) | resumability |

→ Astro + SolidStart 系譜、自己流の発明はなし。

## Options

### A. Build pipeline での `.server.tsx` 除外 (= core)

#### A-α: stub 化 (= 採用案)

client build pass で plugin が `.server.tsx` を **virtual module に置き換える**。元ファイルの本体ロジックは消し、内部 import の `.tsx` (= island) 参照と最小限の shell だけ残す。既存 `serverBoundary` plugin (ADR 0043 で `.server.ts` を空 stub 化する仕組み) と同 pattern を踏襲する。

```tsx
// 元の posts/index.server.tsx
import { db } from "@/data/posts";
import { Counter } from "./counter";

export default async function PostPage() {
  const posts = await db.findAll();
  return (
    <div>
      ...
      <Counter initial={0} />
    </div>
  );
}
```

```tsx
// virtual module (= client bundle 内の posts/index.server.tsx)
import { Counter } from "./counter";
// named map 形式 (= reviewer M-1 反映): 同 component を複数回 JSX 内で使うケースで配列 index がズレるのを回避
export const __islands: Record<string, unknown> = { Counter };
export default function () {
  return null;
}
```

#### A-β: 各 island を独立 entry に追加

build 開始時に `.server.tsx` を AST scan、`rollupOptions.input` に island candidates を追加 entry として注入。Vite が普通に build → 各 island が独立 chunk になる。

#### A-γ: 完全消去 + global registry

`.server.tsx` を完全消去、HTML marker に component id を埋め込み、global registry で lookup。Router の routes table を server / client で別物にする必要あり。

### B. Hydrate marker shape

#### B-α: 範囲 marker `<!--vi-${name}-${seq}-start/end-->` (= 採用案)

ADR 0035 の streaming SSR marker (`<!--vb-${id}-start/end-->`) と **prefix で namespace 分離** された範囲 marker。`vi-` (vidro island) と `vb-` (vidro boundary) で衝突回避 (= reviewer C-1 反映)。

#### B-β: 開始のみ + 親要素境界終端

marker 1 個だけ、終わりは次の marker か親要素 close。

#### B-γ: custom element `<vidro-island name="...">`

parse コスト増、HTML 出力サイズ増。

### C. Island id 規約

#### C-α: name + 出現順併記 (= 採用案 = reviewer M-1 反映)

stub の `__islands` は **named map** (`{ Counter }` 形式)、marker は `vi-${name}-${seq}` で **component 名 + 出現順** を併記。

```
__islands = { Counter, LikeButton }   // build 時 import 文ベースで集めた named map
marker:    <!--vi-Counter-1-start:{...}-->  ... <!--vi-Counter-1-end-->
           <!--vi-Counter-2-start:{...}-->  ... <!--vi-Counter-2-end-->
                                  ^ 同一 component の出現順
```

これで以下を解決:

- 同一 component を JSX 内で複数回使うケースで lookup 安定
- name が一意 key として再利用可能 (= migration 時 Approach B にも乗りやすい)
- seq は marker の Range 同定用 (= 同一 name を区別する補助)

#### C-β: 位置ベース (= 配列 index、reviewer M-1 で却下)

`.server.tsx` 内の N 番目の island = id `1`、stub の `__islands` は配列 index 対応。同一 component の複数 JSX 使用で破綻。

#### C-γ: path ベース / C-δ: hash ベース

`posts__counter` / build hash。debug 困難 / migration コスト高。

### D. Props の渡し方

#### D-α: marker に inline JSON (= 採用案)

`<!--vi-Counter-1-start:{"initial":0}-->` で props を JSON serialize して marker に直接埋め込み。

#### D-β: 別 script tag

`<script>__vidroIslandProps["Counter-1"]={"initial":0}</script>` で別経路。

#### D-γ: 既存 `__vidro_data` sidecar に同居

Phase B の loader sidecar に同居。責務混在。

### E. Registry 接続

#### E-α: `__vidroPendingHydrate` を namespace 分離して流用 (= 採用案 = reviewer C-1 反映)

ADR 0035 の registry に `{ type: "island", name, seq, routeFile }` を **prefix 付き string key** (`vi-${name}-${seq}`) で push。既存 boundary key (`vb-${id}`) と完全に名前空間を分離。

```js
// 既存 (ADR 0035 / streaming Suspense boundary):
window.__vidroPendingHydrate["vb-0"] = () => { ... };

// 新規 (本 ADR / island):
(window.__vidroPendingHydrate ??= []).push({
  type: "island",
  name: "Counter",
  seq: 1,
  routeFile: "/src/routes/posts/index.server.tsx",
});
```

ただし既存 `__vidroPendingHydrate` の shape は `{ [id]: () => void }` map で、本 ADR で push する shape は array。**registry を `{ ...map, queue: [] }` 形式にハイブリッド化する** か **island だけ別 array push して walker で type 判定** するか、実装段階で詰める (= Open Questions)。

#### E-β: 新規 `__vidroIslands` registry

専用 registry を別途作る。**実装段階で E-α のハイブリッド化が複雑になりすぎたら switch 候補** (= reviewer C-1 で「runtime 名前空間混濁コスト」が cost を上回る指摘あり)。

### F. Build error (= reactive primitive 誤用検出)

#### F-α: import 文ベース AST scan (= 採用案)

`.server.tsx` 内で `signal` / `computed` / `effect` / `onMount` / `Resource` / `Suspense` from `@vidro/core` を import している場合 build error。helpful message で「Move reactive logic to a Client Component」を提示。**type-only import は除外する判定は oxc / babel の `importKind === "type"` フラグを使う** (= reviewer W-3 反映、TypeScript の `import type` 構文を AST 上で正確に区別)。

#### F-β: 関数 call の動的検出

import 文だけでなく実際の call site も検出。実装精度高、build cost 増。

#### F-γ: silent (= 検出しない)

ADR 0058 の Decision で「signal 誤用は build error」と決定済なので不採用。

### G. renderToStringAsync default 化

#### G-α: 常に async path (= 採用案)

`.server.tsx` ありなし問わず常に renderToStringAsync。pipeline 単純化。**toy 段階では 2-pass の CPU コスト (= ADR 0030 既知制約) を受容、production 化時に 1-pass + VNode 穴埋め or streaming-only に revisit する** (= reviewer W-1 反映)。

#### G-β: `.server.tsx` ありなしで分岐

build に `.server.tsx` が含まれるかで sync / async を切替。判定ロジック増。

### H. Props serialize 規約

#### H-α: JSON 限定 + serialize 失敗時 throw (= 採用案)

ADR 0058 で「Props は JSON 限定 start」と decide 済。実装は `JSON.stringify` 失敗で throw、build error 化は将来 ADR (= seroval 等の検討と一緒に)。

#### H-β: silent 変換 (Date → ISO string 等)

magic 増、`project_legibility_test` 違反。

## Decision

各論点 **A-α / B-α / C-α / D-α / E-α / F-α / G-α / H-α** を採用。

### Build pipeline (A-α + F-α + G-α)

`@vidro/plugin` に新規 `vidroServerComponentPlugin()` を追加。既存 `serverBoundary` plugin (ADR 0043) の `.server.ts` 空 stub 化 pattern を踏襲する形:

```ts
{
  name: "vidro:server-component",
  enforce: "pre",
  apply(_config, { command }) {
    return command === "build" || command === "serve";
  },
  async load(id) {
    if (!id.endsWith(".server.tsx")) return null;
    // reviewer M-3 反映: Vite 6 multi-environment API で client build / dev SSR を判定
    if (this.environment?.name !== "client") return null;  // server build はそのまま、dev SSR でも素通し

    const source = await fs.readFile(id, "utf-8");
    assertNoReactivePrimitive(source, id);  // F-α: build error 検出 (oxc importKind 判定で type-only 除外)
    const islands = scanClientImports(source);  // import { X } from "./y" のうち .tsx を named で抽出
    return generateStub(islands);  // virtual module (= named map 形式)
  },
}
```

stub のテンプレート (= reviewer M-1 named map 反映):

```tsx
import { Counter } from "./counter";
import { LikeButton } from "./like-button";

// named map 形式: 同 component を複数回 JSX 内で使っても lookup 安定
export const __islands: Record<string, unknown> = { Counter, LikeButton };
export default function () {
  return null;
}
```

### Hydrate marker (B-α + C-α + D-α)

`.server.tsx` 内の Client Component (= JSX で参照されてる `.tsx` import) の前後に marker を挿入:

```tsx
// server output
<div>
  <h1>Posts</h1>
  <!--vi-Counter-1-start:{"initial":0}-->
  <button>0</button>
  <!--vi-Counter-1-end-->
</div>
```

marker 形式 = `vi-${componentName}-${seq}` で **name + 出現順併記** (= reviewer M-1 named map 反映)。stub の `__islands[name]` で named lookup、`seq` は同一 component を複数回使った時の Range 同定。props は marker の `:{...}` 部に JSON serialize。

**marker 出力場所**: `packages/router/src/server.ts` の改修は **vanilla string 操作** で実装する。`@vidro/router` の build pipeline は jsxTransform 不在 (= ADR 0027 派生制約 / `project_pending_rewrites.md`) のため、JSX で marker を吐くと `_$dynamicChild` 書き換えが入らず hydrate cursor mismatch を起こす (= reviewer C-2 反映)。実 marker emit は **core/server の Renderer** (= 既存の `<!--vb-${id}-start/end-->` を吐く機構) に island 用 API を追加する形で協調する。

### Registry 接続 (E-α)

server が marker と並行して `__vidroPendingHydrate` に push する script を吐く。既存 `vb-` namespace との衝突を避けるため **`vi-${name}-${seq}` の prefix 付き string key** で管理する (= reviewer C-1 反映):

```html
<script>
  (window.__vidroPendingHydrate ??= []).push({
    type: "island",
    key: "vi-Counter-1",
    name: "Counter",
    seq: 1,
    routeFile: "/src/routes/posts/index.server.tsx",
  });
</script>
```

ADR 0035 の registry walker を拡張、`type === "island"` の処理 branch を追加。既存 boundary entry (= `vb-` map shape) と本 ADR の island entry (= array push) は **registry を `{ map: { vb-*: () => void }, queue: IslandEntry[] }` のハイブリッド化** で共存させる (= 実装段階の詳細、E-β fallback も視野)。

### Client runtime

`@vidro/router` (or 専用 `@vidro/hydrate-runtime`) に追加 (= reviewer M-1 / C-1 反映):

```ts
async function hydrateIsland(item: IslandEntry) {
  const chunkPath = window.__vidroManifest[item.routeFile];
  const stub = await import(chunkPath);
  const Component = stub.__islands[item.name]; // named lookup (M-1)
  if (!Component) {
    console.warn(`Island '${item.name}' not found in ${item.routeFile}`);
    return;
  }
  const range = findMarkerRange(item.key); // "vi-Counter-1" prefix で boundary "vb-*" と分離 (C-1)
  const props = JSON.parse(extractPropsJSON(range.start));
  // ADR 0035 の boundary hydrate 流用
  hydrateInRange(Component, props, range);
}
```

ADR 0036 の `__vidroBoot` trampoline 経由で発火 (= bundle 先着 → 即実行 / 遅着 → flag 経由)。

### Manifest (B1 / chunk path 解決)

Vite の manifest 機能 (`build.manifest = true`) を有効化、build 後の `manifest.json` を index.html に inline JSON として注入する build hook を `@vidro/plugin` に追加。client runtime は `window.__vidroManifest` から chunk path を解決。

**Cloudflare Workers 統合での 2-pass build 整合**: `@cloudflare/vite-plugin` は `viteEnvironment: { name: "ssr" }` で client + ssr の dual environment build を管理する。client manifest を SSR build hook が読む方式 (= cf-plugin の build order 依存) が成立するか、実装着手前に **spike が必要** (= reviewer M-2 反映、Open Questions に詳細)。

### Static span skip 機構 (= 54th 追加 Decision)

ADR 当初の Decision には書いてなかったが、Phase 2 dogfood で「`.server.tsx` を leaf route の page として使うと shell hydrate cursor が SSR markup と整合しない」issue を踏んだ。原因: client bundle で `.server.tsx` は stub `() => null` に置換されるが、shell hydrate は Router の `<main>{page}</main>` を walk するので、page = null と SSR HTML の `<div>...</div>` の不一致で cursor mismatch する。

Astro は client app entry が島 mount だけで shell hydrate しない設計なのでこの issue を踏まないが、Vidro は Router で shell hydrate する設計のため対応が必要。

**Decision**: ADR 0035 (streaming hydrate) の `HydrationRenderer.skipToComment(value)` API を流用し、`.server.tsx` page output 全体を `<!--vs-1-start-->...<!--vs-1-end-->` で囲む。shell hydrate cursor は span 全体を skip し、内部の島 marker (`<!--vi-X-N-->`) は別経路 (= setupIslandHydration) で hydrate する。

#### 実装

1. **`@vidro/core` に `__VidroServerOnlySection` component 追加** (`packages/core/src/island.ts`)
   - server: page output を `<!--vs-1-start-->...<!--vs-1-end-->` で囲む fragment を出力
   - client (= shell hydrate cursor active = `skipToComment` API 存在): `skipToComment("vs-1-end")` で span を skip + `createComment` 1 回で end marker 消費 (children = stub `() => null` は呼ばない、pure skip)
   - `streaming` flag 判定でなく `skipToComment` 関数の存在 で判別: streaming flag は SSR が Suspense を使った時だけ true なので `.server.tsx` page (Suspense 不使用) では立たない

2. **`@vidro/router` foldRouteTree で leaf route が `.server.tsx` か判定して wrap** (`packages/router/src/router.tsx`)
   - `match.route?.filePath.endsWith(".server.tsx")` で判定
   - 該当時、leaf invoke を `__VidroServerOnlySection({ children: invokeLeaf })` で wrap
   - module に flag inject 不要 (= 既存 `RouteEntry.filePath` を流用、plugin 改修最小)

#### スコープ

- **id 固定 `vs-1`、1 page = 1 span 前提**。layout も `.server.tsx` 化する nested ケースは scope 外
- nested 対応するなら per-render counter 化 (= ADR 0035 streaming context の id 採番と同 pattern)。dogfood で踏んだら拡張する

### Validation の境界

| 項目                                                     | 本 ADR で扱う                 | 別 ADR / 別 task                               |
| -------------------------------------------------------- | ----------------------------- | ---------------------------------------------- |
| `.server.tsx` の build 除外                              | ✅                            | -                                              |
| island detection + hydrate                               | ✅                            | -                                              |
| **core/server Renderer に island marker emit API 追加**  | ✅                            | (= reviewer C-2 反映、router 単独で完結しない) |
| reactive primitive build error (粗版)                    | ✅                            | 関数 call 動的検出は別 ADR                     |
| renderToStringAsync default 化                           | ✅                            | -                                              |
| Props serialize JSON 限定 + throw                        | ✅                            | type-safe upgrade は別 ADR                     |
| dogfood routes (`apps/router/posts/`)                    | ✅                            | -                                              |
| **cf-plugin 2-pass build と Vite manifest の整合 spike** | ✅ (= 実装着手前)             | 本格 production 化対応は別 task                |
| streaming SSR との統合                                   | partial (= registry 流用のみ) | true streaming + island は別 ADR               |
| `.client.tsx` opt-out marker                             | ❌                            | ADR 0061+ 候補 (defer)                         |
| seroval 採用検討                                         | ❌                            | dogfood で踏んでから別 ADR                     |

## Consequences

### Pros

- **ADR 0058 が effective に動く** = bundle 削減効果が実測できる、北極星 (RSC simpler 代替) の dogfood 価値が出る
- **既存機構の流用** = ADR 0035 (registry / boundary hydrate) / ADR 0036 (trampoline) / ADR 0030 (renderToStringAsync) / ADR 0027 (hydrate primitive) を全部活用、新規実装最小
- **Astro + SolidStart 系譜の標準的アプローチ** = 自己流ロックインなし、後で別流派 (Approach B / A-γ) に切り替え余地あり
- **`.server.tsx` + `server.ts` の分業 dogfood** = ADR 0058 の dual file pattern も同時に実証
- **AI 親和** = 拡張子で boundary 即決、import chain 追跡不要
- **MVP 保守的** = 過剰な最適化 (e.g., per-island chunk split) を避け、Vidro target (= 個人 / hobby / cf) に整合

### Cons / Open Questions

- **`__vidroPendingHydrate` registry の shape ハイブリッド化** = 既存 boundary entry (`{ [vb-id]: () => void }` map) と新規 island entry (= `IslandEntry[]` array) の共存実装を walker 側で詰める。`{ map, queue }` 形式 or 別 array push のどちらにするかは plugin 実装段階で判断 (= reviewer C-1、E-β の新規 registry に switch する fallback も視野)
- **cf-plugin 2-pass build と Vite manifest の整合 spike が必須** = `@cloudflare/vite-plugin` の `viteEnvironment: { name: "ssr" }` dual build で client manifest を SSR build hook が読む方式が成立するか、実装着手前に **POC** で確認。NG なら dev / prod で別注入する fallback (= reviewer M-2)
- **core/server Renderer 改修の scope** = router 側 (= server.ts) は vanilla string 操作のみ、実 marker emit は core の Renderer に island 用 API を追加する協調設計。core touchpoint が増える (= reviewer C-2)
- **Streaming SSR との統合は partial** = `__vidroPendingHydrate` 流用までは整合、true streaming + island の per-chunk hydrate は別 ADR (= 内側 nested island の独立化が要 ADR 0033 級の改修)
- **Props serialize JSON 限定の踏み所** = Date / Map / class instance を island に渡したいケースで踏む。本 ADR は JSON.stringify throw、seroval 検討は別 ADR
- **build error の false positive 余地** = 関数 call の動的検出は scope 外なので、re-export 経由 / dynamic import 経由は検出漏れ。粗版で start、踏んだら別 ADR。**type-only import 除外は oxc / babel の `importKind === "type"` フラグで判定** (= reviewer W-3)
- **renderToStringAsync 2-pass cost 受容** = ADR 0030 既知制約、toy 段階では受容、production 化時に 1-pass + VNode 穴埋め or streaming-only に revisit (= reviewer W-1)
- **`.server.tsx` 専用 island の bundle 入り保証** = stub の `__islands` named map が import 文を含むので「孤立 island」は自動解決。ただし dynamic import / lazy import は scope 外
- **dogfood routes のサイズ** = `apps/router/posts/` が新規 5 ファイル + `data/posts.ts`、route 数増。ADR 0058 dogfood 不在の現状を埋めるので投資価値あり
- **既存 routes の migration** = `notes/` / `users/` の `.server.tsx` 化は本 ADR scope 外。dogfood で効果実測後、別 task で個別判断
- **Owner leak (= ADR 0035 既知残課題)** = `tryHydrateBoundary` が root Owner (parent=null) を作るので、navigation で island が破棄されずに effect が GC されない可能性。dogfood の Browser 検証手順で navigate away → re-visit を確認、踏んだら ADR 0035 残課題と一緒に着地 (= reviewer W-2)

### 54th dogfood で見つかった未対応 issue (= 別 task で着地)

- **`<Link>` 複数 thunk children が空文字化** = `<Link>{a}: {b}</Link>` のように複数 expression を Link の children に並べると jsx-transform で配列 of thunk になり、`_$dynamicChild` の Array branch が配列内 function を auto-invoke しないため空 `<a></a>` になる。今回は template literal 回避、本来策は `_$dynamicChild` Array branch の修正 (= `project_pending_rewrites` 追記済)
- **`async function Component()` 未対応** = ADR 0058 の使用例 `async function PostPage() { const post = await db.x() }` は core h() が sync 呼出のため未サポート。今回は sync function で回避、本来策は server renderer の async component path 追加 or Resource + Suspense pattern の `.server.tsx` 内許可 (= `project_pending_rewrites` 追記済)
- **`.server.tsx` page への SPA navigation で真っ白** = `<Link href="/posts">` click で SPA navigation すると client bundle の stub `() => null` で page が空になる。reload (= URL 直打ちの SSR 経路) で見える。本来策は Router の `navigate(path)` で target route の filePath が `.server.tsx` なら `window.location.assign(path)` で full reload 切替 (= `project_pending_rewrites` 追記済、Astro 等他 FW も同様の標準動作)

### 既存 ADR との関係

- **ADR 0058 (.server.tsx semantics)**: 本 ADR で実装、Decision の意味論は ADR 0058 のまま
- **ADR 0057 (FW design stance)**: 強制ゼロ stance 整合、`.server.tsx` は opt-in marker
- **ADR 0035 (progressive hydration foundation)**: registry / cursor / boundary hydrate 流用
- **ADR 0036 (TTI improvement)**: `__vidroBoot` trampoline で島 hydrate 発火
- **ADR 0030 (renderToStringAsync)**: default 化、async path に統一
- **ADR 0027 (B-3d main hydrate)**: hydrate primitive を island 単位で呼出
- **ADR 0015 (Phase A bootstrap)**: loader data の JSON inject、本 ADR の Props inline JSON と並列

### 既存 memory との関係

- `project_vidro_rsc_like_core_model`: 北極星具体実装
- `project_design_north_star`: RSC simpler 代替の effective 化
- `project_html_first_wire`: HTML wire 前提、本 ADR の marker は HTML 内 comment
- `project_pending_rewrites`: Phase C 残課題の partial hydration を本 ADR で着地、boundary owner leak / nested Suspense 等は別途
- `project_rsc_like_rewrites`: touchpoints の `.server.tsx` 拡張子 boundary を ADR 0058 で着地、partial hydration impl を本 ADR で
- `project_fw_design_stance` (ADR 0057): 強制ゼロ stance 整合
- `project_legibility_test`: 拡張子 marker は legible、props inline JSON も legible (= curl で読める)

## Affected files

### Plugin

- `packages/plugin/src/server-component.ts`: 新規。`vidroServerComponentPlugin()` (= load hook、stub 化、build error 検出)。**既存 `serverBoundary` (ADR 0043) と同 pattern**、`this.environment?.name === "client"` で判定
- `packages/plugin/src/scan-imports.ts`: 新規。AST scan で `.tsx` import を named で抽出 (oxc `importKind` で type-only 除外)
- `packages/plugin/src/manifest-inject.ts`: 新規。`generateBundle` hook (enforce: "post") で client manifest を SSR build hook 経由で index.html headExtras に inline 注入
- `packages/plugin/src/index.ts` / `packages/plugin/src/vidro.ts`: 上記を export、`vidro({ router: true })` factory に組み込み
- `packages/plugin/tests/`: stub 化 / build error / island detection / manifest 注入の test

### Router

- `packages/router/src/server.ts`: island registry push script を `headExtras` に追加 (vanilla string 操作のみ、JSX 不可)、core/server Renderer への island marker emit 指令経路追加
- `packages/router/src/client.ts` or 新規 `packages/router/src/island.ts`: `hydrateIsland()` / `findMarkerRange()` / `extractPropsJSON()` / registry walker `type === "island"` branch
- `packages/router/src/router.tsx`: renderToStringAsync default 化 switch (= 元から async 経路だが念のため)、hydrate runner で island walker 追加
- `packages/router/tests/`: island marker / hydrate / registry walker / namespace 分離の test

### Core

- `packages/core/src/server-renderer/`: Renderer に island 用 marker emit API 追加 (= 既存 `<!--vb-${id}-start/end-->` を吐く機構を拡張、`<!--vi-${name}-${seq}-start/end-->` の出力経路追加)。reviewer C-2 反映
- `packages/core/src/server-renderer/streaming-runtime.ts` (or 同等位置): `__vidroPendingHydrate` walker の `type === "island"` branch + namespace 分離 (`vb-*` map と `vi-*` queue の共存)

### Apps (dogfood)

- `apps/router/src/data/posts.ts`: 新規。toy DB (id / title / text / createdAt の配列)
- `apps/router/src/routes/posts/server.ts`: 新規。`getAllPosts()` / `getPostById()` helper (= ADR 0058 の `.server.tsx` + `server.ts` 分業 dogfood)
- `apps/router/src/routes/posts/index.server.tsx`: 新規。一覧 page (server-only)
- `apps/router/src/routes/posts/[id]/index.server.tsx`: 新規。詳細 page (server-only) + Like button 配置
- `apps/router/src/routes/posts/like-button.tsx`: 新規。island (= signal + onClick)
- `apps/router/tsconfig.app.json` / `apps/router/vite.config.ts`: `@/*` path alias 設定 (= 既存 or 新規)、`build.manifest: true` 確認

### Documentation

- `docs/decisions/0060-partial-hydration.md`: 本 ADR (新規、reviewer finding 反映済)

## Validation

### Code 検証

- 既存 test 全 pass
- 新規 test:
  - stub 化 (= virtual module の output が期待通り)
  - reactive primitive 誤用 build error (= signal import で fail)
  - island marker 出力 (= `<!--vi-${id}-start/end-->`)
  - registry push (= `__vidroPendingHydrate` に island entry が追加)
  - hydrate runtime (= marker 範囲で hydrate、event listener attach)

### Build 検証

`vp build` 後、以下を grep で確認:

| 項目                                                                          | 期待                |
| ----------------------------------------------------------------------------- | ------------------- |
| `.vidro/build/client/` 内に "getAllPosts" / "createdAt" 等 server-only 文字列 | **含まれない**      |
| `.vidro/build/client/` 内に `LikeButton` / `signal(0)` 等 island 文字列       | **含まれる**        |
| `.vidro/build/ssr/` 内に server-only 文字列 + island 両方                     | **含まれる** (両側) |
| client bundle に `data/posts.ts` の posts 配列 (= "Vidro RSC-like" 等)        | **含まれない**      |

### Browser 検証 (= dogfood)

- `vp dev` で http://localhost:5173/posts に access → 一覧表示 (= 静的 HTML)
- 詳細 page (`/posts/1`) に navigation → title + text + Like button 表示
- Like button click → count++ (= island hydrate 動作確認)
- 一覧 → 詳細の navigation が HTML wire (= curl で `Accept: text/html` で確認)
- DevTools Network → client bundle に `data/posts.ts` の中身が無いこと
- **navigate away → re-visit 確認** (= reviewer W-2): `/posts/1` で Like button click で count=3 にした後、`/posts/2` に navigate、再度 `/posts/1` に戻る → count が **0 にリセット** されること (= island が一度 dispose されて新規 hydrate)、effect の二重 attach が起きていないこと (= DevTools Performance の event listener 数で確認)
- **同一 component を複数回使うケース** (= reviewer M-1): 詳細 page 内に Like button を 2 つ並べる variant を作って、それぞれの count が独立して動くか確認

### Reviewer agent

- `feature-dev:code-reviewer` agent で本 ADR + 実装 commit を review
- finding を反映してから user 合意 → Accepted
- `feedback_review_in_workflow` per

## Next steps after Accepted

1. **`@vidro/plugin` 改修** (= server-component plugin 追加、AST scan、build error)
2. **`@vidro/router` 改修** (= island marker 出力、hydrate runtime、manifest 注入)
3. **dogfood routes 実装** (= `apps/router/posts/`)
4. **`vp build` + browser 検証** (= bundle 検査、Like button 動作)
5. **memory update** (= `project_next_steps`、`project_pending_rewrites`、`project_rsc_like_rewrites` の touchpoint chain 整理)
6. **未 push commit + 本 ADR commit を origin/main に push**
7. **将来検討** (defer):
   - `.client.tsx` opt-out marker (= ADR 0061+ 候補、必要性が出たら起票)
   - seroval / devalue 採用 (= JSON 限定で踏んだら別 ADR)
   - per-island chunk split (= bundle size の実測で気になったら)
   - true streaming + island の per-chunk hydrate (= ADR 0033 級改修、large app dogfood 後)
   - reactive primitive build error の関数 call 動的検出 (= 粗版で false positive 出たら)
