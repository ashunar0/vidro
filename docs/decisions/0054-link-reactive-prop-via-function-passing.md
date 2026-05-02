# 0054 — `<Link>` の reactive prop は関数渡しで escape hatch を提供する

## Status

**Accepted** — 2026-05-02 (45th session、dogfood 検証済)

依存: ADR 0048 (props snapshot + explicit reactive primitive)、ADR 0052 (`searchParams()` primitive)、ADR 0053 (`LoaderArgs.request`)

## Context

### 痛みの起点 — pagination dogfood

ADR 0053 で server-side pagination 経路 (`?page=N`) が成立した。`/notes` page で Prev/Next の pagination UI を組もうとしたところ、初手の自然な書き方が壊れた:

```tsx
const currentPage = computed(() => Number(sp.page.value ?? "1"));

const buildHref = (page: number): string => {
  const params = new URLSearchParams();
  if (page > 1) params.set("page", String(page));
  return params.toString() ? `?${params}` : "/notes";
};

// ↓ これが動かない
<Link href={buildHref(currentPage.value - 1)}>Prev</Link>
<Link href={buildHref(currentPage.value + 1)}>Next</Link>
```

**症状**: page=1 で SSR された時点で `buildHref(0)` / `buildHref(2)` が評価されて Link に渡される。Next を click → URL は `?page=2` に更新、page 内容も更新。**だが Prev/Next の href は最初の値で固まる**。page=2 にいる時に Next を押すと `?page=2` (= 同 URL) に飛ばされ何も起きない、Prev は `/notes` (= page=1) には行ける、という壊れ方。

### 構造的な原因 — ADR 0048 の component snapshot 規約

ADR 0048 で「Component の props は snapshot」を decide している。`<Link href={X}>` の `X` は **mount 時に 1 度評価されて固定**、後で変わらない。`currentPage.value` が変わっても Link の内部の `<a>` 要素の href は更新されない。

これは ADR 0048 の設計通りで bug ではなく **意図された挙動**。React mental model + Solid 実装の Vidro identity の核。

### 生 `<a>` との非対称

検証で判明した重要な事実: **Vidro plugin の transform + `applyProp` の実装で、生 host element の attribute は既に reactive 化されている**。

```tsx
// 生 <a> の path
<a href={buildHref(currentPage.value - 1)}>Prev</a>
// → plugin が _reactive(() => buildHref(...)) で wrap
// → h("a", { href: _reactive_marker_fn })
// → applyProp が関数を見て effect で wrap (packages/core/src/jsx.ts:300-307)
// → DOM 属性が currentPage 変化に追従 ✓

// Link (component) の path
<Link href={buildHref(currentPage.value - 1)}>Prev</Link>
// → 同じく _reactive(() => buildHref(...)) で wrap
// → h(Link, { href: _reactive_marker_fn })
// → wrapComponentProps が ADR 0048 規約に従って _reactive marker を即時評価して unwrap
// → Link 内部で props.href は string snapshot
// → 内部の h("a", { href: props.href }) は文字列を渡すだけ、reactive じゃない ✗
```

つまり Vidro は **「Component prop は snapshot (ADR 0048)、Host element attr は reactive (Solid 流)」というハイブリッド規約** を採用している。Link が component である以上、ADR 0048 規約の側に倒れて snapshot 化される。

### 44th session での暫定対処

44th では pagination を `<button onClick={() => navigate(buildHref(...))}>` に倒した。click handler は click 時に評価される closure なので最新値を読める。

ただしこの workaround は `<a>` semantics を捨てる cost がある:

- middle click / cmd+click で新タブが開けない
- right click → "リンクをコピー" / "新しいタブで開く" メニューが出ない
- ブラウザの link prefetch hint (= 将来の `<Link rel="prefetch">` 拡張) が効かない
- 見た目を `<a>` っぽくする CSS 重複

dogfood として「pagination のような **dynamic href な navigation**」を `<Link>` で書ける必要があると判断、本 ADR で escape hatch を設計する。

### Vidro identity からの制約

memory `feedback_props_unification_preference` (= ADR 0048 素材): props snapshot + explicit reactive primitive 派、destructure 罠を回避する選択。
memory `project_legibility_test`: 「読んで日本語に訳せる」基準で magic を最小化。
memory `project_design_north_star`: RSC simpler 代替、AI フレンドリーは副産物、企業採用は狙わない。
memory `project_3tier_architecture`: 薄い core、split-when-confused、機能で切らず環境で切る。

→ Solid 流 (component prop も全 reactive) に戻すのは destructure 罠を抱え直すことになる。ADR 0048 の判断を維持しつつ、Link の使い勝手問題を局所的に解く path が筋。

## Options

### (A) 関数渡しで reactive escape hatch

```tsx
<Link href="/about">About</Link>                                   {/* static (現状維持) */}
<Link href={() => buildHref(currentPage.value - 1)}>Prev</Link>    {/* reactive */}
<Link
  href={() => buildHref(currentPage.value - 1)}
  class={() => currentPage.value <= 1 ? "opacity-30 px-3 py-1" : "px-3 py-1 hover:bg-gray-100"}
>Prev</Link>
```

- Link.href / Link.class の type を `string | (() => string)` に拡張
- 内部で関数判定 → effect で applyProp 化、文字列なら現状の static path
- ADR 0048 の `<Show when={() => signal.value}>` 流の関数渡し pattern と統一
- 「reactive escape hatch は関数渡し」という Vidro convention が立つ

### (Y) Link を ADR 0048 例外として透過 reactive

```tsx
<Link href={buildHref(currentPage.value - 1)}>Prev</Link>          {/* 関数 wrap 不要、reactive */}
```

- Link の props を `wrapComponentProps` で unwrap せず、`_reactive` marker を保持
- user は今のまま `<Link href={buildHref(...)}>` で動く
- DX 最高だが ADR 0048 規約に **新しい分類軸** ("host-like wrapper primitive" = 透過 reactive) を導入する必要が出る
- 「次の Link 的 primitive (`<Image>` `<Form>` 等) も透過？」が case-by-case 議論になる

### (X) Link 廃止、生 `<a>` のみ

```tsx
<a
  href={buildHref(currentPage.value - 1)}
  onClick={(e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (e.button !== 0) return;
    e.preventDefault();
    navigate(buildHref(currentPage.value - 1));
  }}
>
  Prev
</a>
```

- framework は薄くなる
- modifier-click handling / aria-current / navigate() 起動を user が毎 link で書く負担
- prerender / prefetch の将来拡張点を失う

### (W) ADR 0048 を host attr にも拡張、全 snapshot 化

```tsx
<a href={signal.value}>          {/* snapshot、変わらない */}
<a href={() => signal.value}>    {/* reactive にしたいなら関数 */}
<input value={text.value}>       {/* snapshot 化、input 値が更新されない */}
```

- 規約は「全 JSX 式 snapshot、reactive は明示」で完全に揃う
- でも fine-grained DOM 更新の DX が大幅劣化、既存 sample app が大量に壊れる
- Solid / Vue / Svelte / Marko 全部 host attr reactive default、Vidro だけ outlier に

### (Solid 流に戻す) ADR 0048 を破棄、ADR 0007 復活

```tsx
function Counter(props) {
  return <p>{props.count}</p>; // props.count は getter、reactive
}
const { count } = props; // ← destructure すると reactivity 死亡
```

- Component prop も Host attr も両方 reactive で揃う
- destructure 罠が戻る (memory `feedback_props_unification_preference` で破棄した path)
- ADR 0048 を覆す大規模 reframe、本 ADR の scope 外

## Decision

**(A) 関数渡しで reactive escape hatch** を採用する。

加えて、本 ADR は **convention** として:

> **SPA 内 navigation は `<Link>` を推奨、raw `<a>` は外部 link / mailto / in-page anchor 等の非 navigation のみ**

を明文化する。これにより user が日常書く navigation は常に Link 経由になり、「Link は snapshot rule、生 `<a>` は reactive」の不揃いが visible にならない。

### scope

- **Link.href**: `string | (() => string)` を受ける
- **Link.class**: `string | (() => string)` を受ける (= pagination の disabled 状態見た目を Link で書けるため込み)
- Link.match / Link.children: 現状維持 (= match は config 系、children は `_$dynamicChild` 経路で別機構)

### 実装方針

`packages/router/src/link.tsx` の中で:

```ts
type LinkProps = {
  href: string | (() => string);
  class?: string | (() => string);
  children?: unknown;
  match?: "exact" | "prefix";
};

export function Link(props: LinkProps): Node {
  const resolveHref = (): string => (typeof props.href === "function" ? props.href() : props.href);

  const handleClick = (e: MouseEvent) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    if (e.button !== 0) return;
    e.preventDefault();
    navigate(resolveHref()); // click 時の最新値で navigate
  };

  // initial mount 時の static 値を h() に渡す。reactive 化は applyProp に任せる。
  const node = h("a", { onClick: handleClick }) as HTMLAnchorElement;

  // href / class は関数なら applyProp 経由で reactive、文字列なら direct setAttribute
  applyHrefOrClass(node, "href", props.href);
  if (props.class !== undefined) applyHrefOrClass(node, "class", props.class);

  // active state も resolveHref() を effect 内で読むことで dynamic href に追従
  const renderer = getRenderer();
  effect(() => {
    const matchMode = props.match ?? "exact";
    const currentHref = resolveHref(); // 関数なら呼び出し → 中の signal を track
    if (isActive(currentPathname.value, currentHref, matchMode)) {
      renderer.setAttribute(node, "aria-current", "page");
    } else {
      renderer.removeAttribute(node, "aria-current");
    }
  });

  // children は既存の _$dynamicChild 経路で post-order を保つ
  appendChildren(
    node,
    _$dynamicChild(() => props.children),
  );
  return node;
}
```

(= 詳細実装は実 commit で確定、上記は方針の sketch)

`applyProp` (`packages/core/src/jsx.ts`) は既に Signal / 関数の reactive path を持っている (jsx.ts:293-307) ので、Link 内で `applyProp(node, "href", props.href)` を呼べば関数判定 → effect 化が自動で走る。Link 側で再実装不要。

ただし Link は ADR 0048 の `wrapComponentProps` で props を受け取るため、関数 prop が `_reactive` marker と衝突しないか実装時に確認が必要 (= Open Questions 参照)。

## Rationale

### 1. ADR 0048 規約を維持しつつ局所問題を解く

(A) は ADR 0048 の「component prop は snapshot」rule を破らない。`<Link href={fn}>` の `fn` は **value としての関数**を渡す形なので snapshot として一貫している (= 「snapshot された関数を Link が effect 内で呼ぶ」)。

ADR 0048 は既に escape hatch として 2 つの形を sanction している:

> もしくは `<Show when={() => signal.value}>` で関数渡し、Show 内部で関数呼び出し
> reactive な切り替えが欲しいなら `<Show when={signal}>` で Signal を渡し、Show 内部で `when.value` を effect で読む

本 ADR は前者 (関数渡し) を Link.href / Link.class に拡張するだけ。新規 design 言語の追加ではなく、既存 convention の適用範囲拡大。

### 2. memory `project_legibility_test` と整合

「読んで日本語に訳せるか」基準:

- `<Link href="/about">About</Link>` → 「Link に static な href 渡す」(= 既存と同じ)
- `<Link href={() => buildHref(currentPage.value - 1)}>Prev</Link>` → 「Link に href 計算関数を渡す。Link が必要に応じて呼ぶ」(= 関数を渡す = 後で呼ばれる、JS 直感)
- `<a href={signal.value}>` → 「a 要素の href 属性に signal.value を bind」(= 既存と同じ)

Link reactive と Show reactive が同じ pattern (`() => ...`) で揃う。

### 3. (Y) を採らない理由 — 規約軸の増加コスト

(Y) は user の DX 上は最高だが、Vidro の component 規約に **「host-like wrapper primitive 分類」** という新軸を加える。

| Component 種別               | reactive rule (Y 採用時)   |
| ---------------------------- | -------------------------- |
| user 自作 component          | snapshot (ADR 0048)        |
| Show / For / Switch / Match  | snapshot (ADR 0048 継続)   |
| **Link (host-like wrapper)** | **透過 reactive** (= 例外) |
| 将来の `<Image>` / `<Form>`  | ?? (case-by-case 議論)     |

新分類が増えるたび「これは透過？snapshot？」の判定が要る。memory `project_3tier_architecture` の split-when-confused に逆行。(A) なら Vidro 全 component で「snapshot rule、reactive は関数 or Signal」の 1 axis で統一できる。

### 4. (X) を採らない理由 — 拡張点の喪失

Link 廃止すると：

- user は modifier-click handling と aria-current logic を毎 link で書く (= 重複)
- 将来の prefetch / prerender / scroll-restore 等の機能を集約する場所がない
- memory `project_design_north_star` の「個人開発に役立つ薄い sugar」を提供する責務を放棄

Link は **薄いがゼロではない sugar** として有用。dynamic href の少数事例のために廃止するのは過剰。

### 5. (W) / Solid 流に戻すを採らない理由

(W) は fine-grained reactivity の DX を捨てる、Solid 流復活は destructure 罠を抱え直す。両方とも ADR 0048 で意図的に避けた path。本 ADR の局所問題のために大判断を覆すのは過剰。

### 6. convention "use Link, not <a>" の効用

`<a>` vs `<Link>` の不揃いを user の日常 DX から消す。実用上 `<a>` を navigation に使うケースは Link 採用後ほぼ消える。残るのは:

- 外部 link (`https://example.com`) → href が dynamic に変わるケース稀
- mailto / tel / in-page anchor → 同上
- これらでは asymmetry が visible にならない

つまり convention 1 行で「日常 DX 上の不揃い」を解消できる。

## Consequences

### user code への影響

- 現状の `<Link href="/static">` 形式は **完全に互換**、変更不要
- dynamic href が必要な場合は `<Link href={() => buildHref(...)}>` で書ける
- pagination dogfood (apps/router/src/routes/notes/index.tsx) を Prev/Next button から Link に書き直し可能

### 実装変更箇所

1. `packages/router/src/link.tsx`: LinkProps の type 拡張、関数判定 + applyProp 経路、aria-current effect の dynamic href 追従、handleClick の最新 href 取得
2. `packages/router/tests/` (= 既存テストあれば): 関数渡し path のテスト追加
3. `apps/router/src/routes/notes/index.tsx`: pagination Prev/Next を `<Link>` に書き直し dogfood

### bundle / perf

- Link 内部で `typeof props.href === "function"` 判定 1 回追加、無視できる cost
- 関数渡し時は effect 1 個追加、これも無視できる
- static 渡し時は現状と同じ path、cost ゼロ

### convention 文書化

本 ADR 自体が convention の primary source。dogfood で混乱が起きたら CLAUDE.md / 設計書側にも明記する。

### 関連既存規約との整合

| 規約                                           | 整合性                                                 |
| ---------------------------------------------- | ------------------------------------------------------ |
| ADR 0048 (component prop snapshot)             | ✓ 維持、関数 value も snapshot として渡る              |
| memory `feedback_props_unification_preference` | ✓ explicit reactive primitive 派の延長                 |
| memory `project_legibility_test`               | ✓ 「関数を渡す = 後で呼ばれる」と訳せる                |
| memory `project_design_north_star`             | ✓ Link は薄い sugar として個人 dev に有用              |
| memory `project_3tier_architecture`            | ✓ 薄い core 維持、機能追加せず escape hatch だけ広げる |

## Open Questions

### 1. `wrapComponentProps` と `_reactive` marker の干渉

ADR 0048 で component に渡る `_reactive(() => expr)` marker は `wrapComponentProps` で即時評価して unwrap される。本 ADR で **user が明示的に渡す関数** ( `() => buildHref(...)` ) も `_reactive` marker と区別できる必要がある:

- user 関数: marker property 無し、Link 内部で typeof チェックで関数として扱う
- plugin 自動 wrap: marker property 付き、`wrapComponentProps` で unwrap

実装時に marker 判定ロジックを確認、user 関数が誤って unwrap されないか実機検証が必要。

### 2. SSR 時の挙動

server render 時:

- 関数を 1 回呼んで初期 href を HTML に焼く
- aria-current の effect も 1 回走って初期 attribute を焼く
- client hydrate 時に effect が再起動して subscribe 確立

これは ADR 0035 / 0036 の SSR phase C と同じ flow。新規 hazard なし、と想定するが実機検証が要る。

### 3. class の `() => string` 以外の形

将来 `class` prop が **object 形式** (`{ "is-active": isActive.value, "is-disabled": isDisabled.value }`) を受けたい場面が出るかもしれない。本 ADR では string only に limit、object 形式は別 ADR で議論。

### 4. 他 prop の関数渡し対応

現状 scope b では `href` + `class` のみ。将来 `aria-label`、`title`、`tabIndex` 等が dynamic に必要になれば個別判断。一気に全 prop 対応すると ADR 0048 例外を増やす印象になるので、dogfood で痛み出てから拡張する方針。

## Revisit when

- **`<Image>` / `<Form>` 等の他 host-like wrapper primitive が登場した時**: 同じ「component prop snapshot vs host attr reactive」問題が再来する。本 ADR の関数渡し convention をそのまま適用するか、別 path を採るか議論。
- **Vidro の syntax foundation が変わった時**: Ripple 系の declarative compiler / TSRX 系の TS-integrated reactive 等に乗り換える判断が出れば、本 ADR の前提自体が変わる。memory `project_pending_rewrites` 級の大論題。
- **destructure 罠を許容する判断が出た時**: ADR 0048 を破棄して Solid 流 reactive props に戻す path が再浮上したら、本 ADR も同時に redo。

## 関連

- ADR 0007 — Superseded by ADR 0048、Solid 流 implicit reactive props の歴史
- ADR 0048 — 本 ADR の前提、component prop snapshot 規約
- ADR 0052 — `searchParams()` primitive、URL client state path Y
- ADR 0053 — `LoaderArgs.request`、server-side pagination 経路
- memory `feedback_props_unification_preference` — 本 ADR の素材
- memory `project_legibility_test` — 「読んで訳せる」基準
- memory `project_design_north_star` — 薄い sugar / 個人 dev 規模
- memory `project_3tier_architecture` — split-when-confused、薄い core
