import { Signal } from "./signal";
import { Effect } from "./effect";
import { Owner } from "./owner";

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
    // component は独立した child Owner の中で 1 回だけ評価する (invoke-once)
    const owner = new Owner();
    return owner.run(() => type(resolvedProps));
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
  const node = owner.run(fn);
  target.appendChild(node);
  return () => {
    node.parentNode?.removeChild(node);
    owner.dispose();
  };
}

// --- internal helpers ---

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
    new Effect(() => {
      text.data = toText(child.value);
    });
    return;
  }

  if (typeof child === "function") {
    // A 方式 compile transform の結果 (`{expr}` → `() => expr`) を受ける
    const text = document.createTextNode("");
    parent.appendChild(text);
    new Effect(() => {
      text.data = toText((child as () => unknown)());
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

// Element に 1 つの prop を適用する。on[Event] は listener、function / Signal は reactive。
function applyProp(el: Element, key: string, value: unknown): void {
  if (key.startsWith("on") && key.length > 2 && typeof value === "function") {
    const eventName = key.slice(2).toLowerCase();
    el.addEventListener(eventName, value as EventListener);
    return;
  }

  if (value instanceof Signal) {
    new Effect(() => {
      setAttr(el, key, value.value);
    });
    return;
  }

  if (typeof value === "function") {
    new Effect(() => {
      setAttr(el, key, (value as () => unknown)());
    });
    return;
  }

  setAttr(el, key, value);
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
