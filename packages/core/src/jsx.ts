import { Signal } from "./signal";
import { effect } from "./effect";
import { untrack } from "./observer";
import { flushMountQueue, runWithMountScope } from "./mount-queue";
import { Owner } from "./owner";
import { Ref } from "./ref";
import { getRenderer } from "./renderer";

/** Fragment marker: `<>...</>` / `h(Fragment, null, ...)` で children をグループ化する。 */
export const Fragment = Symbol("Fragment");

type ComponentFn = (props: Record<string, unknown>) => Node;

/**
 * JSX 要素を Renderer 経由で構築する。type が文字列なら IntrinsicElement、関数なら
 * Component (new child Owner の中で 1 回だけ呼ぶ)、Fragment なら fragment ノードを返す。
 * DOM 依存はすべて getRenderer() 経由 (ADR 0016)。
 */
export function h(
  type: string | ComponentFn | typeof Fragment,
  props: Record<string, unknown> | null,
  ...children: unknown[]
): Node {
  const r = getRenderer();

  if (type === Fragment) {
    const frag = r.createFragment();
    for (const child of children) appendChild(frag, child);
    return frag;
  }

  if (typeof type === "function") {
    const resolvedProps: Record<string, unknown> = props ?? {};
    // children を props.children に合流させる (1 件なら unwrap、それ以外は配列のまま)
    if (children.length === 1) resolvedProps.children = children[0];
    else if (children.length > 1) resolvedProps.children = children;
    // A 方式の `{expr}` → `() => expr` 変換を component 境界でも貫くため、props を
    // Proxy でラップして「読むたびに関数を評価」する。これで intrinsic 同様に
    // reactive props (`count={signal.value}` → 読むたびに current value) が動く。
    // 例外: `on*` は event handler、`children` は render callback / Node / 多態
    // を渡すスロットなので素通し。destructure すると getter が 1 度しか走らず
    // reactivity が死ぬので使い手は `const x = props.foo` 的な個別参照を使う。
    const propsProxy = wrapComponentProps(resolvedProps);
    // component は独立した child Owner の中で 1 回だけ評価する (invoke-once)。
    // runCatching で囲んで、component 関数内の throw を nearest ErrorBoundary に届ける。
    // 例外で undefined が返ったら placeholder Comment を返す — ErrorBoundary があれば
    // その effect が fallback を差し替えるので placeholder は実質見えない。Boundary 無しなら
    // handleError が root で再 throw するのでここには到達しない。
    const owner = new Owner();
    const result = owner.runCatching(() => type(propsProxy));
    return result ?? r.createComment("vidro-error");
  }

  const el = r.createElement(type);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      applyProp(el, key, value);
    }
  }
  for (const child of children) appendChild(el, child);
  return el;
}

/**
 * JSX element を target に mount する。戻り値は dispose 関数で、呼ぶと DOM を除去 + 配下の
 * Effect / child Owner を全て解放する。fn を thunk で受けるのは、root Owner を active にした
 * 状態で JSX を評価するため (h の内側で作られる Effect / 子 Owner がこの root に紐づく)。
 *
 * `mount` は意味論的に **fresh render**: target の既存 children をまず空にしてから新しい
 * tree を append する。SSR (`renderToString`) で焼かれた markup が既にあっても問答無用で
 * 上書き — Phase B-2c の暫定挙動 (一瞬 blink するが状態は壊れない)。Step B-3 の
 * `hydrate(fn, target)` が入ったら、SSR markup を保ったまま walk + effect attach する
 * 別 API として共存する。
 *
 * mount は client only の API なので、target.* は DOM を直接触る (ADR 0016 例外)。
 */
export function mount(fn: () => Node, target: Element): () => void {
  // detached root (parent=null) を作って mount 用の独立スコープにする
  const owner = new Owner(null);
  // runWithMountScope で囲んでいる間、onMount(fn) が queue に積まれる。
  // appendChild の後に flush して、fn は DOM attach 済みの状態で呼ばれる。
  const node = runWithMountScope(() => owner.run(fn));
  // SSR markup や前回 mount 残骸を全消してから fresh attach。replaceChildren は
  // jsdom / 全 modern browser で 1 op で空にできて速い。
  target.replaceChildren();
  target.appendChild(node);
  flushMountQueue();
  return () => {
    node.parentNode?.removeChild(node);
    owner.dispose();
  };
}

// --- internal helpers ---

// 内部 marker key (symbol ではなく property にすることで、transform 生成コードから
// 直接 `fn.__vidroReactive = true` と書けるようにする)。
const REACTIVE_MARKER = "__vidroReactive" as const;

type ReactiveThunk = (() => unknown) & { [REACTIVE_MARKER]?: boolean };

/**
 * A 方式 transform が JSX 内の `{expr}` を `_reactive(() => expr)` に書き換える際に
 * 呼ばれる runtime helper (attribute 位置)。返り値は同じ関数だが marker property
 * が付くので、component 境界の Proxy が「ユーザーが書いた arrow」と区別して展開できる。
 *
 * 使うのは transform だけで、手で書く API ではない (underscore prefix で internal 表現)。
 */
export function _reactive<T>(fn: () => T): () => T {
  (fn as ReactiveThunk)[REACTIVE_MARKER] = true;
  return fn;
}

/**
 * JSX child position の literal text (`<div>hi</div>` の "hi") を transform が書き換えた
 * call 先 (ADR 0019)。h() の引数として **先に** 評価されることで `createText` が
 * `createElement(parent)` より前に呼ばれ、HydrationRenderer の post-order cursor
 * (`<div>hi</div>` の post-order: text, div) と一致する。
 */
export function _$text(value: unknown): Node {
  return getRenderer().createText(toText(value));
}

/**
 * adjacent text/expr boundary に server / client / hydrate 全 mode で同一の
 * empty Comment Node を emit する helper (ADR 0055)。
 *
 * HTML parser は adjacent な text を 1 個の Text Node に merge する仕様があるため、
 * `<button>foo {x}</button>` の SSR 出力 `<button>foo 0</button>` は browser 側で
 * 1 Text Node にまとめられる。client は `_$text("foo ")` + `_$dynamicChild(() => x)`
 * の **2 Text Node** を expect しているので post-order cursor がズレる。
 *
 * `@vidro/plugin` の jsx-transform.ts が intrinsic 親内の adjacent text/expr 隣接を
 * 検知して、間に `_$marker()` を inject する。server は VComment "" → HTML `<!---->`、
 * client は cursor で Comment Node 1 個を消費 → 両者一致。
 *
 * value="" の Comment は anchor 系 ("show", "switch" 等) と完全一致 check で衝突しない
 * (ADR 0055 Open Question 1 参照)。
 */
export function _$marker(): Node {
  return getRenderer().createComment("");
}

/**
 * JSX child position の `{expr}` (`<div>{count.value}</div>`) を transform が書き換えた
 * call 先 (ADR 0019)。peek + (Array / Node / primitive 判定) を h() より前に行い、
 * 必要なら effect で reactive 追従を仕掛けた上で Node を返す。
 *
 * 旧来 jsx.ts 内の `appendChild` ヘルパーで「function を peek + createText」していた
 * 経路は手書き JSX の後方互換のため残してあるが、transform 経由ではこの helper
 * が先に解決するので post-order が崩れない。
 */
export function _$dynamicChild(thunk: () => unknown): Node {
  const r = getRenderer();
  let peeked = untrack(thunk);

  // 0-arg 関数は children getter として auto-invoke する (ADR 0026、B-4-b)。
  // layout の `<main>{children}</main>` で children が `() => Node` の形で
  // 渡ってきた時に、user 側で `{children()}` と書かなくても展開できるようにする。
  // jsx.ts の handwritten path (appendChild) も同じく function を auto-invoke
  // する設計と一貫性を持たせる。length !== 0 (例: For の (item, i) => ...) は
  // render callback として素通し (本 helper には到達しないが念のため)。
  if (typeof peeked === "function" && (peeked as Function).length === 0) {
    peeked = (peeked as () => unknown)();
  }

  if (Array.isArray(peeked)) {
    const frag = r.createFragment();
    for (const item of peeked) {
      if (item == null || item === false || item === true) continue;
      if (r.isNode(item)) {
        r.appendChild(frag, item);
        continue;
      }
      // 配列内の primitive は static として展開 (動的差し替えは <For> を使う想定)。
      r.appendChild(frag, r.createText(toText(item)));
    }
    return frag;
  }

  if (peeked != null && r.isNode(peeked)) return peeked;

  if (peeked instanceof Signal) {
    const initial = toText(peeked.value);
    if (initial === "") {
      return _emptyDynamicSlot(r, () => peeked.value);
    }
    const text = r.createText(initial);
    effect(() => {
      r.setText(text, toText(peeked.value));
    });
    return text;
  }

  // primitive 値 or unknown → dynamic text。peek した値を初期 text にすることで
  // hydration の cursor 先頭から既存 SSR text content と value 一致しやすい。
  //
  // ADR 0056: 初期値が toText で "" になるケース (LogicalExpression `x && <p/>` の
  // x falsy 時 / null / undefined / boolean / 空文字 など) は、SSR で escapeText("") = ""
  // になり HTML markup に Text Node が現れないので hydrate cursor mismatch する。
  // empty Comment placeholder (`<!---->`) で SSR/hydrate を symmetric にする。
  if (toText(peeked) === "") {
    return _emptyDynamicSlot(r, thunk);
  }
  const text = r.createText(toText(peeked));
  effect(() => {
    let v = thunk();
    // reactive update path も auto-invoke (children が signal で差し替わる
    // ようなケースは無いが、対称性のため)。
    if (typeof v === "function" && (v as Function).length === 0) v = (v as () => unknown)();
    if (v instanceof Signal) v = v.value;
    r.setText(text, toText(v));
  });
  return text;
}

// ADR 0056: 初期値 empty な dynamic slot 用 helper。Comment placeholder を return し、
// client/hydrate では effect 内で comment ↔ text を DOM swap して reactivity を維持する。
// server は effect が untrack 状態で 1 回走るだけで以降 fire しないので、Comment が
// そのまま serialize されて `<!---->` が emit される。
//
// effect 内では `getRenderer()` を毎回呼んで「実行時点の active renderer」を取る。
// hydrate 中に install された effect は、hydrate 完了後 (= setRenderer で browserRenderer
// に戻った後) に signal 変化で re-run される。引数の `r` (= HydrationRenderer) を
// closure で掴んでしまうと、後発の `r.createText` が cursor 消費を試みて
// "[hydrate] cursor exhausted" で throw する (review #2 で発見)。
function _emptyDynamicSlot(r: ReturnType<typeof getRenderer>, thunk: () => unknown): Node {
  const placeholder = r.createComment("");
  if (r.isServer) return placeholder;

  let current: Node = placeholder;
  effect(() => {
    let v = thunk();
    if (typeof v === "function" && (v as Function).length === 0) v = (v as () => unknown)();
    if (v instanceof Signal) v = v.value;
    const next = toText(v);
    const isComment = current.nodeType === 8 /* Node.COMMENT_NODE */;
    const active = getRenderer();
    if (next === "") {
      if (!isComment) {
        const replacement = active.createComment("");
        const parent = current.parentNode;
        if (parent) parent.replaceChild(replacement, current);
        current = replacement;
      }
      return;
    }
    if (isComment) {
      const replacement = active.createText(next);
      const parent = current.parentNode;
      if (parent) parent.replaceChild(replacement, current);
      current = replacement;
    } else {
      active.setText(current as Text, next);
    }
  });
  return current;
}

// Component に渡す props を Proxy でラップする。getter アクセス時に transform 由来
// の marker 付き関数だけを展開し、ユーザーが書いた arrow (event handler / render
// callback / fallback factory 等) は関数のまま素通す。
function wrapComponentProps(rawProps: Record<string, unknown>): Record<string, unknown> {
  return new Proxy(rawProps, {
    get(target, key) {
      const raw = (target as Record<string | symbol, unknown>)[key];
      if (key === "children") return raw;
      if (typeof key === "string" && key.startsWith("on") && key.length > 2) return raw;
      if (typeof raw === "function" && (raw as ReactiveThunk)[REACTIVE_MARKER]) {
        return (raw as () => unknown)();
      }
      return raw;
    },
  });
}

// 親 Node に 1 つの child slot 値を追加する。Signal / 関数は Effect で reactive 追従する。
function appendChild(parent: Node, child: unknown): void {
  if (child == null || child === false || child === true) return;

  const r = getRenderer();

  if (Array.isArray(child)) {
    for (const c of child) appendChild(parent, c);
    return;
  }

  if (r.isNode(child)) {
    r.appendChild(parent, child);
    return;
  }

  if (child instanceof Signal) {
    // B 書き: `{signal}` をそのまま渡された場合のサポート
    const text = r.createText("");
    r.appendChild(parent, text);
    effect(() => {
      r.setText(text, toText(child.value));
    });
    return;
  }

  if (typeof child === "function") {
    // A 方式 compile transform の結果 (`{expr}` → `() => expr`) を受ける。
    // 依存追跡なしで peek して、返り値が静的な構造 (Array / Node) の場合は static
    // スロットとして展開する。配列を動的に差し替えたいケースは <For> を使う想定で、
    // appendChild では初回評価のみの挿入にとどめる。
    // primitive / Signal は dynamic text として effect 内で追従。
    const peeked = untrack(() => (child as () => unknown)());
    if (Array.isArray(peeked)) {
      for (const c of peeked) appendChild(parent, c);
      return;
    }
    if (r.isNode(peeked)) {
      r.appendChild(parent, peeked);
      return;
    }
    const text = r.createText("");
    r.appendChild(parent, text);
    // 初回は上の peek で評価済みだが、依存追跡に乗せるため effect 内で改めて呼ぶ。
    // `{signal}` が transform されたケースでは返り値が Signal instance になるので、
    // もう一段 .value を読んで unwrap する (forward-compat)。
    effect(() => {
      let v = (child as () => unknown)();
      if (v instanceof Signal) v = v.value;
      r.setText(text, toText(v));
    });
    return;
  }

  // primitive (string / number / bigint 等)
  r.appendChild(parent, r.createText(toText(child)));
}

// null / undefined / false は空文字、primitive は文字列化、object 等は空文字で妥協する
function toText(value: unknown): string {
  if (value == null || value === false) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

// input.value / checkbox.checked / option.selected 等は attribute ではなく DOM property で
// 扱う必要がある (ユーザー操作で変動する live state と attribute が別 bookkeeping のため)。
const PROPS_AS_PROPERTY = new Set(["value", "checked", "selected"]);

// Element に 1 つの prop を適用する。on[Event] は listener、function / Signal は reactive。
function applyProp(el: Element, key: string, value: unknown): void {
  const r = getRenderer();

  // ref={myRef} は属性としてではなく、Ref インスタンスの .current に要素を代入して終了。
  // Ref 以外 (関数 callback 等) は現状サポート対象外、黙って attribute 化せず捨てる。
  if (key === "ref") {
    if (value instanceof Ref) (value as Ref<Element>).current = el;
    return;
  }

  if (key.startsWith("on") && key.length > 2 && typeof value === "function") {
    const eventName = key.slice(2).toLowerCase();
    r.addEventListener(el, eventName, value as EventListener);
    return;
  }

  const apply = PROPS_AS_PROPERTY.has(key) ? setProperty : setAttr;

  if (value instanceof Signal) {
    effect(() => {
      apply(el, key, value.value);
    });
    return;
  }

  if (typeof value === "function") {
    effect(() => {
      let v = (value as () => unknown)();
      if (v instanceof Signal) v = v.value;
      apply(el, key, v);
    });
    return;
  }

  apply(el, key, value);
}

// DOM property に直接代入 (null / undefined は空文字へ正規化)
function setProperty(el: Element, key: string, value: unknown): void {
  getRenderer().setProperty(el, key, value);
}

// class / className / style を特別扱いし、それ以外は setAttribute / removeAttribute を使う
function setAttr(el: Element, key: string, value: unknown): void {
  const r = getRenderer();

  if (key === "class" || key === "className") {
    r.setClassName(el, toAttrString(value));
    return;
  }

  if (key === "style" && value !== null && typeof value === "object") {
    r.assignStyle(el, value as Record<string, unknown>);
    return;
  }

  if (value == null || value === false) {
    r.removeAttribute(el, key);
    return;
  }

  if (value === true) {
    r.setAttribute(el, key, "");
    return;
  }

  r.setAttribute(el, key, toAttrString(value));
}

// 属性値として受け入れる primitive のみ文字列化する。オブジェクト等は空文字にして
// "[object Object]" のゴミ値を setAttribute に渡さないようにする。
function toAttrString(value: unknown): string {
  if (value == null || value === false) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

// JSX の型宣言 (permissive)。Stage 1 では全 intrinsic 要素を Record<string, unknown> で受ける。
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    type Element = Node;
    interface IntrinsicElements {
      [elemName: string]: Record<string, unknown>;
    }
    interface ElementChildrenAttribute {
      children: unknown;
    }
  }
}
