// server 用の Renderer 実装 (object tree 版)。ADR 0016 の Step B-2a で導入。
// client の browserRenderer が document.* を呼ぶのに対し、server は tree を
// 組み立てる → serialize で HTML string に落とす 2 pass 構成。
//
// v1 は tree 派、将来 v2 で string buffer に reshape する予定 (ADR 0016 論点 2)。
// Renderer I/F の形は client / server で共通なので、jsx.ts 側の書き換え無しで
// 切り替え可能。

import type { Renderer } from "./renderer";

// --- server 用の VNode 型 (内部表現) ---

type VElement = {
  kind: "element";
  tag: string;
  attrs: Record<string, string>;
  className: string | null;
  style: Record<string, unknown> | null;
  /** value / checked / selected 等の DOM property。serialize で attribute として出す */
  properties: Record<string, unknown>;
  children: VNode[];
};

type VText = {
  kind: "text";
  value: string;
};

type VComment = {
  kind: "comment";
  value: string;
};

type VFragment = {
  kind: "fragment";
  children: VNode[];
};

/**
 * async function component (ADR 0066) の Promise<Node> を VNode 木に
 * 埋め込むための placeholder。h() の component branch が Promise を返す
 * type を見たら、本 slot を生成して return する (= 同期に渡せる Node を
 * 親に挿げ替える)。Promise の then-handler が `resolved` に解決値を書き込み、
 * caller (renderToStringAsync / flushBoundary) が `Promise.allSettled` で
 * 全 settle を待ってから serialize に進む。
 *
 * `resolved === null` を serialize で踏むのは構造的 bug (= allSettled 後 serialize
 * の流れで起きないはず) なので、ADR 0066 Q3 確定形「always throw、dev/prod
 * 区別なし」で fail-fast する (= Phase 3 で serialize 分岐を追加)。
 *
 * 本 type は server-only (= client 側は jsx.ts の h() で client mode runtime guard
 * により async component 自体が throw されるため、VAsyncSlot まで到達しない)。
 */
export type VAsyncSlot = {
  kind: "async-slot";
  resolved: VNode | null;
};

export type VNode = VElement | VText | VComment | VFragment | VAsyncSlot;

// --- server renderer 実装 ---

export const serverRenderer: Renderer<VNode, VElement, VText> & {
  readonly isServer: true;
} = {
  isServer: true,
  isNode(value): value is VNode {
    // VNode は全員 `kind` を持つ discriminator 付き union。duck-typing で判定。
    return (
      typeof value === "object" &&
      value !== null &&
      "kind" in value &&
      (value as { kind: unknown }).kind !== undefined
    );
  },
  createElement(tag) {
    return {
      kind: "element",
      tag,
      attrs: {},
      className: null,
      style: null,
      properties: {},
      children: [],
    };
  },
  createText(value) {
    return { kind: "text", value };
  },
  createFragment() {
    return { kind: "fragment", children: [] };
  },
  createComment(value) {
    return { kind: "comment", value };
  },
  appendChild(parent, child) {
    // text / comment への append は runtime 的にあり得ないが、to be safe に no-op
    if (parent.kind === "element" || parent.kind === "fragment") {
      parent.children.push(child);
    }
  },
  setAttribute(el, key, value) {
    el.attrs[key] = value;
  },
  removeAttribute(el, key) {
    delete el.attrs[key];
  },
  setProperty(el, key, value) {
    el.properties[key] = value ?? "";
  },
  setClassName(el, value) {
    el.className = value;
  },
  assignStyle(el, style) {
    if (el.style === null) el.style = {};
    Object.assign(el.style, style);
  },
  setText(textNode, value) {
    textNode.value = value;
  },
  addEventListener() {
    // server では event listener を捨てる。hydration 時に client で attach
    // される (Step B-3 予定)
  },
};

// --- serialize (VNode → HTML string) ---

// HTML void element (閉じタグを持たない要素)。https://html.spec.whatwg.org/#void-elements
const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

/** VNode tree を HTML string に serialize する。 */
export function serialize(node: VNode): string {
  if (node.kind === "text") return escapeText(node.value);
  if (node.kind === "comment") return `<!--${node.value}-->`;
  if (node.kind === "fragment") {
    let out = "";
    for (const c of node.children) out += serialize(c);
    return out;
  }
  if (node.kind === "async-slot") {
    // ADR 0066 Q3 確定形: `resolved === null` を serialize で踏むのは構造的 bug
    // (= caller が Promise.allSettled を待ってから serialize する流れで、本来到達
    // しない経路)。dev/prod 区別なく always throw して fail-fast にする。
    if (node.resolved === null) {
      throw new Error(
        "[vidro] VAsyncSlot serialized before resolve — async function component Promise was not awaited. " +
          "This is a Vidro internal bug; please report it.",
      );
    }
    return serialize(node.resolved);
  }
  return serializeElement(node);
}

function serializeElement(el: VElement): string {
  let attrs = "";
  for (const [k, v] of Object.entries(el.attrs)) {
    attrs += ` ${k}="${escapeAttr(v)}"`;
  }
  if (el.className !== null) {
    attrs += ` class="${escapeAttr(el.className)}"`;
  }
  if (el.style !== null) {
    attrs += ` style="${escapeAttr(serializeStyle(el.style))}"`;
  }
  // property として渡された value / checked / selected を attribute に展開する。
  // form 制御系は HTML の初期値として出しておくと、hydration 前の form 操作でも
  // 正しく反映される。
  for (const [k, v] of Object.entries(el.properties)) {
    if (k === "value") {
      attrs += ` value="${escapeAttr(String(v))}"`;
    } else if (k === "checked" && v) {
      attrs += " checked";
    } else if (k === "selected" && v) {
      attrs += " selected";
    }
  }

  const open = `<${el.tag}${attrs}>`;
  if (VOID_TAGS.has(el.tag)) return open;

  let inner = "";
  for (const c of el.children) inner += serialize(c);
  return `${open}${inner}</${el.tag}>`;
}

// style object を CSS 文字列に変換 (backgroundColor → background-color)。
// 数値を px に補完する等の親切は toy 段階では入れない (Solid も同じ)。値は primitive
// のみを受け入れ、object 等は "[object Object]" 混入を防ぐため無視する。
function serializeStyle(style: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(style)) {
    if (v == null || v === false) continue;
    if (typeof v !== "string" && typeof v !== "number") continue;
    parts.push(`${toKebabCase(k)}:${v}`);
  }
  return parts.join(";");
}

function toKebabCase(s: string): string {
  return s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

// text content の HTML escape。`<`, `>`, `&` だけで十分 (text node の中では
// 引用符の escape 不要)。
function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// attribute value の HTML escape。`"` で囲むので `"` と `&` と `<` を escape。
function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
