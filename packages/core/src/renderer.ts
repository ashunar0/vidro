// DOM 依存を抽象化するための Renderer I/F。
// ADR 0016: client は document.* を呼ぶ browserRenderer、server は object tree or
// string buffer を組み立てる stringRenderer (Step B-2 で実装) を module state
// に差し替えて JSX runtime を universal に動かす。
//
// Node / Element / Text の default は DOM 型。server renderer は runtime で
// object tree を扱うので setRenderer() の呼び出し時に `as unknown as Renderer`
// で cast する。toy runtime の境界コストとして許容。

export type Renderer<N = Node, E extends N = N, T extends N = N> = {
  createElement(tag: string): E;
  createText(value: string): T;
  createFragment(): N;
  createComment(value: string): N;
  appendChild(parent: N, child: N): void;
  setAttribute(el: E, key: string, value: string): void;
  removeAttribute(el: E, key: string): void;
  /** value / checked / selected など DOM property として扱うべき prop */
  setProperty(el: E, key: string, value: unknown): void;
  setClassName(el: E, value: string): void;
  assignStyle(el: E, style: Record<string, unknown>): void;
  /** reactive text の値更新 (初回生成は createText) */
  setText(textNode: T, value: string): void;
  addEventListener(el: E, type: string, handler: EventListener): void;
};

// client (browser) 用の Renderer 実装。document.* をそのまま呼ぶ薄い wrapper。
const browserRenderer: Renderer<Node, Element, Text> = {
  createElement(tag) {
    return document.createElement(tag);
  },
  createText(value) {
    return document.createTextNode(value);
  },
  createFragment() {
    return document.createDocumentFragment();
  },
  createComment(value) {
    return document.createComment(value);
  },
  appendChild(parent, child) {
    parent.appendChild(child);
  },
  setAttribute(el, key, value) {
    el.setAttribute(key, value);
  },
  removeAttribute(el, key) {
    el.removeAttribute(key);
  },
  setProperty(el, key, value) {
    (el as unknown as Record<string, unknown>)[key] = value ?? "";
  },
  setClassName(el, value) {
    (el as HTMLElement).className = value;
  },
  assignStyle(el, style) {
    Object.assign((el as HTMLElement).style, style);
  },
  setText(textNode, value) {
    textNode.data = value;
  },
  addEventListener(el, type, handler) {
    el.addEventListener(type, handler);
  },
};

// module state で現在の Renderer を保持。Cloudflare Workers は 1 isolate 1 request
// で single-threaded なので global state の交錯は起きない。Node / Deno adapter
// で並列 request を同一 isolate で捌く必要が出たら AsyncLocalStorage に移行。
// 型は client 前提 (Node / Element / Text) で固定し、server renderer は setRenderer
// 時に `as unknown as Renderer<Node, Element, Text>` で cast して流し込む (ADR 0016)。
let currentRenderer: Renderer<Node, Element, Text> = browserRenderer;

/**
 * Renderer を差し替える。server entry が navigation 処理の入口で呼び、処理後に
 * defensive reset するのが典型パターン。
 */
export function setRenderer(r: Renderer<Node, Element, Text>): void {
  currentRenderer = r;
}

/** 現在 active な Renderer を取得。JSX runtime が内部で使う。 */
export function getRenderer(): Renderer<Node, Element, Text> {
  return currentRenderer;
}
