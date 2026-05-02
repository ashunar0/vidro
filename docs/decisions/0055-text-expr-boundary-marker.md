# 0055 — adjacent text/expr の hydrate 境界に separator comment を挿入

## Status

**Accepted** — 2026-05-02 (46th session、user 合意取得済)

依存: ADR 0019 (`_$text` / `_$dynamicChild`、JSX child の post-order 化)、ADR 0025 (intrinsic vs component child の transform 振り分け)

## Context

### 痛みの起点 — 自然な JSX が hydrate で壊れる

`apps/router` の `/` page で hydrate cursor mismatch が出ていた (memory `project_pending_rewrites`、43rd〜45th 繰越案件)。発火箇所は普通に書いた以下の JSX:

```tsx
<button>Go to User #{count.value}</button>
```

console error:

```
[hydrate] text mismatch: expected "Go to User #", got "Go to User #0"
[hydrate] cursor mismatch: expected text "0", got <button> at index 22
```

最初の warn の時点で SSR と client の Text node 構造がズレている。続けて 1 個分 cursor を消費しすぎて以降全部巻き込み連鎖。

### 構造的な原因 — 3 つが重なって発生

1. **HTML parser 仕様**: adjacent text を 1 個の Text node に merge する。`<button>foo bar</button>` は parser を通った時点で 1 Text node `"foo bar"` になる
2. **Vidro の post-order cursor**: `HydrationRenderer` (`packages/core/src/hydration-renderer.ts`) は target subtree を post-order flatten した queue を **Node 数も種類も完全一致** で消費する設計
3. **JSX transform** (ADR 0019 + 0025): intrinsic 親内の `JSXText` と `JSXExpressionContainer` を独立に `_$text(...)` / `_$dynamicChild(...)` に変換する。両者は **別々の Text node** を生成する

→ server emit: 「2 Node 出すつもり」(`_$text("Go to User #")` + `_$dynamicChild(0)`)
→ HTML markup: `<button>Go to User #0</button>` (separator なし連結)
→ browser parse: **1 Node に merge**
→ client cursor: 2 Node を expect → 最初の text が長すぎてズレる + 2 個目を探すと button が来てる → mismatch

### 影響範囲は広い

ユーザーが普通に書く JSX で頻繁に踏むパターンなのだ:

```tsx
<h1>Welcome, {user.name}!</h1>
<span>{count} items</span>
<p>残り {seconds} 秒</p>
<a>Page {n}</a>
<button>Add #{nextId}</button>
```

回避策として user に template literal で 1 dynamic 化させる手もある:

```tsx
<button>{`Go to User #${count.value}`}</button>      {/* 動く、でも醜い */}
<h1>{`Welcome, ${user.name}!`}</h1>
```

dogfood では未だ `apps/router/` の少数箇所だが、user が「読んで日本語に訳せる」JSX を書いた瞬間に踏む構造的なバグ。memory `project_legibility_test` の `legibility test` (= 普通に読めれば OK) に正面衝突する。

### 同種問題の他 FW 解決策

| FW              | 仕組み                                                            | text/expr 境界の扱い                                                                                |
| --------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **Solid**       | compile 時に template 化 + `cloneNode` + marker 位置に `insert()` | 静的 text は template に焼かれて merge 問題が起きない。marker comment は dynamic 挿入位置を示すだけ |
| **React** (18+) | hyperscript / VDOM、SSR string emit                               | adjacent な text 間に `<!-- -->` (空白入り comment) を挿入して Text node を分離                     |
| **Marko**       | template-based compile                                            | Solid 同様 template に焼かれる                                                                      |
| **Svelte**      | template + dynamic insert                                         | 同上                                                                                                |

つまり「marker comment で boundary を作る」アプローチは **FW 界の標準ツールキット**。Vidro が outlier にはならない。

### Vidro identity からの制約

memory `project_legibility_test`: 普通に読めれば OK の magic 許容ライン
memory `project_design_north_star`: RSC simpler 代替、AI フレンドリーは副産物
memory `project_3tier_architecture`: 薄い core、split-when-confused

→ user に template literal を強制するのは legibility test に反するのだ。compile 時に解決して user code は素直なまま、が筋。

## Options

### (A) JSX transform で adjacent text/expr boundary に separator comment を挿入

```tsx
{
  /* user code (現状から変更なし) */
}
<button>Go to User #{count.value}</button>;

{
  /* compile 後 */
}
h(
  "button",
  null,
  _$text("Go to User #"),
  _$marker(), // ← 新規 helper、empty comment を emit
  _$dynamicChild(() => count.value),
);
```

- server: VComment "" → HTML `<!---->` (4-byte の valid empty comment)
- client: cursor が Comment node 1 個を期待 + 消費
- browser parser: Text + Comment + Text の 3 node に正しく分離
- ADR 0021 / 0022 / 0023 / 0024 で導入済の anchor comment と同じ機構の延長

### (B) adjacent text/expr を 1 つの dynamic に combine

```tsx
{
  /* user code (変わらない) */
}
<button>Go to User #{count.value}</button>;

{
  /* compile 後 */
}
h(
  "button",
  null,
  _$dynamicChild(() => "Go to User #" + String(count.value)), // 全体を 1 dynamic に統合
);
```

- 1 Text node に統合 → merge 問題が消える
- でも transform は **隣接 text/expr を全部結合する** logic が要る、edge case 多い
  - `<p>foo {a} bar {b} baz</p>` → `_$dynamicChild(() => "foo " + a + " bar " + b + " baz")`
  - signal 1 個変化で text 全体が再評価 (= fine-grained 効かない)
- legibility test: コンパイル後の挙動が "static text も effect で再評価" になる、user mental model から離れる

### (C) 何もしない (= user に template literal を強制)

```tsx
<button>{`Go to User #${count.value}`}</button>
```

- 実装コスト 0
- legibility test 違反、dogfood で大量に踏む UX
- 「Vidro は普通の JSX を書くと壊れる FW」という汚名

### (D) runtime を Solid 流 template + cloneNode に reshape

- compile 時に静的部分を `<template>` 文字列として焼き、dynamic 位置に marker comment、runtime は cloneNode + insert
- text merge 問題は構造的に消える
- でも Vidro の hyperscript-based runtime を全部書き直す巨大手術。ADR 0019 / 0021〜0024 / 0027 全部 reshape
- toy 段階で採用するには cost が大きすぎる、Phase E 級論題

## Decision

**(A) JSX transform で adjacent text/expr boundary に separator comment を挿入** を採用する。

### 挿入対象

intrinsic 親 (lowercase tag、ADR 0025 の判定と同じ) の **children sequence** を scan、以下の adjacent pair の間に `_$marker()` を挿入:

| Prev child                                                     | Next child                                  | 挿入する?                         |
| -------------------------------------------------------------- | ------------------------------------------- | --------------------------------- |
| JSXText                                                        | JSXExpressionContainer (非 Element 系 expr) | ✓                                 |
| JSXExpressionContainer (非 Element 系 expr)                    | JSXText                                     | ✓                                 |
| JSXExpressionContainer (非 Element 系 expr)                    | JSXExpressionContainer (非 Element 系 expr) | ✓                                 |
| any                                                            | JSXElement / JSXFragment                    | ✗ (Element 自身が node boundary)  |
| JSXElement / JSXFragment                                       | any                                         | ✗                                 |
| (改行を含む whitespace JSXText は cleanJSX で drop されるので) | —                                           | (= sequence から除外して隣接判定) |

「非 Element 系 expr」の判定:

- `t.isJSXElement(expr) || t.isJSXFragment(expr)` を **静的に** 検出できればその expr は marker 不要
- それ以外 (= 識別子、関数 call、演算、template literal、null/undefined literal 等) は **runtime に Text Node になり得る** → marker 入れる
- 関数式 (`() => ...`) も marker 入れる (= ErrorBoundary children 等は intrinsic 親には来ない、来ても安全側で comment 1 個増えるだけ)

### whitespace JSXText の扱い (= reviewer 指摘 #2 反映)

JSXText が **whitespace-only** で **改行を含む** 場合 (`"\n  "` 等) のみ skip 対象として `injectMarkers` の prev 更新から除外する。babel/oxc の `cleanJSXElementLiteralChild` が次の rule で処理するため:

| value                          | trim()=="" | 改行含む | cleanJSX 後      | injectMarkers での扱い          |
| ------------------------------ | ---------- | -------- | ---------------- | ------------------------------- |
| `"foo bar"`                    | false      | -        | preserve         | textish (boundary 判定参加)     |
| `"\n  bar"`                    | false      | -        | "bar" (preserve) | textish (boundary 判定参加)     |
| `"\n  "` (改行 + indent only)  | true       | true     | drop             | **skip** (prev 更新せず)        |
| `" "` (single-line whitespace) | true       | false    | preserve as " "  | **textish** (boundary 判定参加) |

最後の行が reviewer 指摘 #2 で見つかった微妙な case。`<p>{a} {b}</p>` の " " が runtime で Text Node 化されるので、boundary 判定に textish として参加させないと SSR の `[a] [b]` が browser で 1 Text Node に merge されて hydrate cursor がズレる。

### marker 判定の binding-safe 化 (= reviewer 指摘 #1 反映)

`injectMarkers` が挿入した `_$marker()` call を 2 周目 traverse で再 wrap させない skip 判定は、**identifier 名 文字列マッチではなく Symbol-keyed AST flag** で判別する:

```ts
const VIDRO_MARKER_TAG = Symbol("vidro:marker");

function makeMarkerExpressionContainer(): t.JSXExpressionContainer {
  const node = t.jsxExpressionContainer(t.callExpression(t.identifier("_$marker"), []));
  (node as MarkedNode)[VIDRO_MARKER_TAG] = true;
  return node;
}

function isInjectedMarkerNode(node: t.JSXExpressionContainer): boolean {
  return (node as MarkedNode)[VIDRO_MARKER_TAG] === true;
}
```

これで `import { _$marker as m } from "@vidro/core"` の alias 経由 user 呼び出しと、injectMarkers が生成した node を確実に区別できる (parser から symbol-keyed property は付かないので false-positive がない)。

### 新規 helper `_$marker()`

`packages/core/src/jsx.ts` に追加:

```ts
export function _$marker(): Node {
  return getRenderer().createComment("");
}
```

server / client / hydrate 全 mode で動く (renderer.createComment は全 implementation 完備)。

### plugin transform 変更

`packages/plugin/src/jsx-transform.ts` の `JSXElement` (intrinsic 親) traversal に children scan pass を追加:

```ts
// children traversal の前 or 後に scan して、結果を h() の children に inject
function injectMarkers(parent: t.JSXElement): void {
  const children = parent.children;
  const out: t.JSXElement["children"] = [];
  let prev: t.JSXElement["children"][number] | null = null;

  for (const c of children) {
    if (isWhitespaceOnlyText(c)) {
      out.push(c);
      continue;
    }
    if (prev && needsMarker(prev, c)) {
      out.push(makeMarkerExpressionContainer());
    }
    out.push(c);
    prev = c;
  }
  parent.children = out;
}
```

`needsMarker` は上の表通り。`_$marker` は `ensureCoreImports` の HelperName に追加。

## Rationale

### 1. legibility test を死守する

user は **普通に JSX を書ける** (`<button>Go to User #{count.value}</button>`)。compile 時の magic は user mental model から見えない (= comment 1 個増えるだけで意味は変わらない)。

memory `project_legibility_test` の基準で:

- before: 普通に書くと壊れる (= legibility 死亡)
- after (A): 普通に書ける、内部に空 comment が入るだけ、user は気付かない (= legibility 維持)

### 2. fine-grained reactivity を維持する

(B) と違い、text 部分は static、dynamic 部分だけ effect で reactive 追従が引き続き働く。Vidro identity = Solid 流 fine-grained を捨てない。

### 3. FW 界標準ツールキット内

React も Marko も似た marker 系 mechanism を持つ。Vidro が outlier 路線を取るわけではない。Solid は template に倒れて回避してるが、Vidro は hyperscript 基盤なので React 寄りの separator が筋。

### 4. ADR 0019 / 0021〜0024 系の機構と整合

既存 anchor comment 系 (`<!--show-->` `<!--switch-->` `<!--for-->` `<!--error-boundary-->`) と同じ「server / client / hydrate 全 renderer で comment を emit/consume」path に乗る。新設計を持ち込まずに既存機構の延長で解決。

### 5. cost は無視できる

- HTML 増分: boundary 1 つあたり 8 byte (`<!---->`)、まとめて gzip すれば実質ゼロ
- runtime: cursor 1 step + Comment Node 1 個、microsec 級
- bundle: `_$marker` は `createComment("")` を返す 1 行 helper、tree-shake すれば未使用 page で消える

## Consequences

### user code への影響

- 既存 user code は **完全互換**、変更不要
- 「template literal で逃げる」回避策は不要に。素直な JSX で書ける
- dogfood で `<button>Go to User #{count.value}</button>` 系が動く

### 実装変更箇所

1. `packages/core/src/jsx.ts`: `_$marker` helper を export
2. `packages/core/src/index.ts`: `_$marker` を re-export (= plugin が import 出来るよう)
3. `packages/plugin/src/jsx-transform.ts`: `JSXElement` traversal に children scan + marker inject pass、`HelperName` / `ensureCoreImports` に `_$marker` 追加
4. `apps/router/` で `pack` 実行 → app 起動 → / 直打ち + 全 route 確認

### bundle / perf

- HTML markup +8 byte / boundary
- client cursor +1 step / boundary
- 通常 page で boundary 数は 10 個前後、合計増分 80 byte 程度

### SSR / streaming SSR / hydrate 全部互換

- server-renderer: 既存 `createComment` path
- streaming-hydration: 既存 `createComment` path、cursor は Comment を 1 個 expect で OK
- vanilla mount (CSR): comment は DOM に 1 個増えるだけ、UX 変化なし

### 既存 hydrate test への影響

`packages/core/tests/` で hydrate cursor を検証している test がある場合、marker 追加で SSR markup と post-order queue が変わる。test fixture を更新する必要があるかも (= 実装時に確認)。

### 関連既存規約との整合

| 規約                                                          | 整合性                                                                |
| ------------------------------------------------------------- | --------------------------------------------------------------------- |
| ADR 0019 (`_$text` / `_$dynamicChild` の post-order)          | ✓ 延長、JSX transform に scan pass を追加するだけ                     |
| ADR 0025 (intrinsic vs component の child transform 振り分け) | ✓ intrinsic 親のみで marker 挿入、component 親は children getter 化済 |
| memory `project_legibility_test`                              | ✓ user code 変更不要、magic は隠蔽                                    |
| memory `project_3tier_architecture`                           | ✓ core に 1 helper 追加、plugin に 1 pass 追加、薄い core 維持        |

## Open Questions

### 1. marker と既存 anchor comment の干渉

`<Show>` / `<Switch>` 等の primitive は `<!--show-->` 等の non-empty anchor を吐く。`<!---->` (= empty value) と区別したい場面があるか?

→ `HydrationRenderer.createComment(value)` は value 引数を expect するが、Comment Node 自体の data は server / client 両方で同じ value で作られる前提。`_$marker` は value `""`、anchor は value 名前付き。

server-renderer.ts の `serialize` で comment は `<!--${value}-->` を吐く。value="" なら `<!---->`、これは valid HTML5 comment。browser parser が問題なく Comment node として読み込む。

実装時に **空 value comment が anchor 系の `skipToComment` 等で誤判定されないか** を確認する。`skipToComment(value)` は `n.nodeValue === value` で完全一致 check してるので、value="" なら anchor 系 ("show", "switch" 等) と衝突しない。

### 2. JSX transform の expr 種別判定の精度

「JSXElement / JSXFragment 以外」を marker 必要とみなす判定で、以下のケースを誤判定しないか:

- `<div>{<span />}</div>` → expr が JSXElement、marker 不要 ✓
- `<div>{condition && <span />}</div>` → expr が LogicalExpression、static 判定では Element になる場合があるが marker 入れる方向で OK (= comment が 1 個増えるだけ)
- `<div>{[<a />, <b />]}</div>` → expr が ArrayExpression、Array 内に Element、marker は前後 text と接する場合だけ問題、現状の transform は `_$dynamicChild` で fragment 化するので marker 1 個で問題ない

→ 安全側で「JSXElement / JSXFragment 直書きのみ marker 不要」、それ以外は marker 入れる方向で実装。

### 3. 既存 `apps/temp` (CSR) / 既存 hydrate test への影響

memory `project_app_scaffolding_strategy`: `apps/temp` は CSR canonical template、`apps/temp-router` は SSR + router canonical。両方で marker が乗っても CSR は cursor を使わない (= mount path) ので新規の hydrate mismatch は起きない。

`packages/core/tests/` 内の hydrate fixture は **実機 SSR から HTML を作って HydrationRenderer に流し込む** 形なので、新 marker が SSR 出力に乗れば自動で fixture 更新される。手動で string fixture を持ってる test は要更新。

### 4. ADR 0048 component 規約との関係

本 ADR は intrinsic 親の child sequence のみを対象。component 親の child transform (= `() => ...` getter 化) は ADR 0025 で別経路、本 ADR の影響範囲外。

### 5. JSXFragment 親の adjacent text/expr (= reviewer 指摘 #3、defer)

`<>foo {x}</>` のような JSXFragment 親内の adjacent text/expr は本 pass で marker injection されない。Fragment children は runtime で `DocumentFragment` に集約され、最終的に親 intrinsic Element に flatten append される。SSR serialize でも Fragment は children を直結 emit するだけ。

例: `<div><>foo {x}</></div>` の場合、最終 HTML は `<div>foo[x]</div>` になり、browser parse で 1 Text Node に merge される hazard が残る。

**defer 理由**:

- apps/router の現 dogfood では JSXFragment 内に adjacent text/expr を書く pattern は出ていない (= 検索済み、`<></>` 自体の使用が少ない)
- 対応するには `traverse(ast, { JSXFragment: { enter: ... } })` を追加 + Fragment の children scan を実装する必要があり、Fragment の edge-flatten (= Fragment の最初/最後の child が Fragment 外の adjacent と merge する) も含めて設計が膨らむ
- 本 ADR の primary scope (= `/` page の `Go to User #{count.value}` mismatch) は `<button>` (intrinsic) 直下の問題だったので、Fragment 拡張は本 ADR には含めず別 ADR に切り出す

dogfood で JSXFragment 内の text/expr 並びによる hydrate mismatch が報告されたら、本 ADR の延長として injectMarkers を JSXFragment にも適用する別 ADR (= 0056 候補) を起票する。

## Revisit when

- **template-based runtime に migrate する判断が出た時** (= Phase E or 後): Solid 流 template + cloneNode 方式に乗り換えるなら本 ADR は構造的に不要に。component-side template も含めて全 ADR 0019〜 をまとめて書き直し
- **bundle size の cost が気になり始めた時**: marker comment による HTML 増分が無視できなくなれば、SSR string buffer 化 (`render-to-string` v2) のタイミングで minify pass を入れる
- **anchor comment の value 命名規則を再設計する時**: 現状 anchor は名前付き value (`show` / `switch` 等)、marker は value="". 名前空間衝突の可能性が出たら anchor を `vidro:` prefix 等に揃える別 ADR

## 関連

- ADR 0019 — `_$text` / `_$dynamicChild`、post-order cursor 化、本 ADR の前提
- ADR 0021 / 0022 / 0023 / 0024 — anchor comment 系、既存の comment-based hydrate 機構
- ADR 0025 — intrinsic vs component の child transform 振り分け
- ADR 0027 — Router 側 `_$dynamicChild` 手書き化、本 ADR とは別問題
- memory `project_legibility_test` — 「読んで訳せる」基準、本 ADR の動機
- memory `project_pending_rewrites` — `/` page hydrate cursor mismatch を未解析として保管
- memory `project_3tier_architecture` — 薄い core / plugin layered 維持
