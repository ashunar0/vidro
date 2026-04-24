import { Signal } from "./signal";
import { effect } from "./effect";
import { untrack } from "./observer";
import { flushMountQueue, runWithMountScope } from "./mount-queue";
import { Owner } from "./owner";
import { Ref } from "./ref";

/** Fragment marker: `<>...</>` / `h(Fragment, null, ...)` で children をグループ化する。 */
export const Fragment = Symbol("Fragment");

type ComponentFn = (props: Record<string, unknown>) => Node;

/**
 * JSX 要素を real DOM として構築する。type が文字列なら IntrinsicElement、関数なら Component
 * (new child Owner の中で 1 回だけ呼ぶ)、Fragment なら DocumentFragment を返す。
 */
export function h(
  type: string | ComponentFn | typeof Fragment,
  props: Record<string, unknown> | null,
  ...children: unknown[]
): Node {
  if (type === Fragment) {
    const frag = document.createDocumentFragment();
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
    return result ?? document.createComment("vidro-error");
  }

  const el = document.createElement(type);
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
 */
export function mount(fn: () => Node, target: Element): () => void {
  // detached root (parent=null) を作って mount 用の独立スコープにする
  const owner = new Owner(null);
  // runWithMountScope で囲んでいる間、onMount(fn) が queue に積まれる。
  // appendChild の後に flush して、fn は DOM attach 済みの状態で呼ばれる。
  const node = runWithMountScope(() => owner.run(fn));
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
 * 呼ばれる runtime helper。返り値は同じ関数だが marker property が付くので、
 * component 境界の Proxy が「ユーザーが書いた arrow」と区別して展開できる。
 *
 * 使うのは transform だけで、手で書く API ではない (underscore prefix で internal 表現)。
 */
export function _reactive<T>(fn: () => T): () => T {
  (fn as ReactiveThunk)[REACTIVE_MARKER] = true;
  return fn;
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

  if (Array.isArray(child)) {
    for (const c of child) appendChild(parent, c);
    return;
  }

  if (child instanceof Node) {
    parent.appendChild(child);
    return;
  }

  if (child instanceof Signal) {
    // B 書き: `{signal}` をそのまま渡された場合のサポート
    const text = document.createTextNode("");
    parent.appendChild(text);
    effect(() => {
      text.data = toText(child.value);
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
    if (peeked instanceof Node) {
      parent.appendChild(peeked);
      return;
    }
    const text = document.createTextNode("");
    parent.appendChild(text);
    // 初回は上の peek で評価済みだが、依存追跡に乗せるため effect 内で改めて呼ぶ。
    // `{signal}` が transform されたケースでは返り値が Signal instance になるので、
    // もう一段 .value を読んで unwrap する (forward-compat)。
    effect(() => {
      let v = (child as () => unknown)();
      if (v instanceof Signal) v = v.value;
      text.data = toText(v);
    });
    return;
  }

  // primitive (string / number / bigint 等)
  parent.appendChild(document.createTextNode(toText(child)));
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
  // ref={myRef} は属性としてではなく、Ref インスタンスの .current に要素を代入して終了。
  // Ref 以外 (関数 callback 等) は現状サポート対象外、黙って attribute 化せず捨てる。
  if (key === "ref") {
    if (value instanceof Ref) (value as Ref<Element>).current = el;
    return;
  }

  if (key.startsWith("on") && key.length > 2 && typeof value === "function") {
    const eventName = key.slice(2).toLowerCase();
    el.addEventListener(eventName, value as EventListener);
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
  (el as unknown as Record<string, unknown>)[key] = value ?? "";
}

// class / className / style を特別扱いし、それ以外は setAttribute / removeAttribute を使う
function setAttr(el: Element, key: string, value: unknown): void {
  if (key === "class" || key === "className") {
    (el as HTMLElement).className = toAttrString(value);
    return;
  }

  if (key === "style" && value !== null && typeof value === "object") {
    Object.assign((el as HTMLElement).style, value as object);
    return;
  }

  if (value == null || value === false) {
    el.removeAttribute(key);
    return;
  }

  if (value === true) {
    el.setAttribute(key, "");
    return;
  }

  el.setAttribute(key, toAttrString(value));
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
