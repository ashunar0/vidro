// HydrationRenderer: target の既存 DOM を post-order cursor で消費する Renderer 実装。
// ADR 0019 (Step B-3a)、ADR 0035 で streaming hydrate 拡張。
//
// JSX transform 強化 (`@vidro/plugin` の jsx-transform.ts) で primitive child / dynamic
// child は h() の引数として **先に** 評価されるため、`createElement` / `createText` /
// `createComment` の呼び出し順は target subtree を post-order traversal した順と
// 一致する。HydrationRenderer はこの順で cursor を 1 つずつ前進させ、対応する
// 既存 Node を返す。
//
// mismatch 時の挙動 (Solid 同等):
//   - tag 違い → throw (toy runtime では recovery 不要)
//   - text content 違い → console.warn + override
//   - attribute 同値なら skip、違うなら override
//   - property (value/checked/selected) は SSR HTML に出ないため idempotent に上書き
//
// ADR 0035: streaming hydrate 拡張
//   - `streaming` flag: shell hydrate run 中であることを Suspense が見分けるための
//     marker。Renderer に生やしておき、Suspense client mode が `r.streaming === true`
//     を検出したら children を hold + boundary registry に push する経路に分岐する
//   - `range` option: boundary 単位 hydrate 用。`{ start, end }` の comment Node を
//     渡すと、cursor は start.nextSibling から end.previousSibling までの subtree
//     のみを post-order で消費する (root 全体ではなく)

import type { Renderer } from "./renderer";

/** Renderer に streaming flag を生やすための型拡張 (内部用)。 */
export type HydrationRenderer = Renderer<Node, Element, Text> & {
  /** shell hydrate run 中なら true。Suspense が children を hold するか判定する。 */
  streaming?: boolean;
  /**
   * cursor を指定 comment value (例: `vb-vb0-end`) を指す位置まで進める。
   * 戻った時点では cursor は **end marker そのものを指している** (= 次の
   * `createComment` で消費される)。streaming Suspense の boundary 範囲スキップ用
   * (ADR 0035): shell hydrate 中、fallback markup or resolved children のいずれが
   * DOM 上に居ても cursor を一括前進させて mismatch を回避する。
   * 見つからなければ throw する (defensive)。
   */
  skipToComment?(value: string): void;
};

// target の subtree を post-order で flatten。Element / Text / Comment のみ拾う
// (DOCUMENT_FRAGMENT_NODE 等は対象外)。子は left→right、親は子の後。
function postOrderNodesOfRoot(root: Node): Node[] {
  const out: Node[] = [];
  const visit = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      visit(child);
    }
    out.push(node);
  };
  for (const child of Array.from(root.childNodes)) {
    visit(child);
  }
  return out;
}

// start と end は同じ parent に居る前提 (`<!--vb-${id}-start-->` /
// `<!--vb-${id}-end-->`)。start.nextSibling から end.previousSibling までの
// 各 sibling を root に持つ subtree を post-order で flatten する。
function postOrderNodesOfRange(start: Node, end: Node): Node[] {
  const out: Node[] = [];
  const visit = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      visit(child);
    }
    out.push(node);
  };
  let n: Node | null = start.nextSibling;
  while (n && n !== end) {
    visit(n);
    n = n.nextSibling;
  }
  return out;
}

function describeNode(n: Node): string {
  if (n.nodeType === Node.ELEMENT_NODE) return `<${(n as Element).tagName.toLowerCase()}>`;
  if (n.nodeType === Node.TEXT_NODE) return `text "${(n as Text).data}"`;
  if (n.nodeType === Node.COMMENT_NODE) return "comment";
  return `nodeType=${n.nodeType}`;
}

export type CreateHydrationRendererOptions = {
  /**
   * shell hydrate run 中であることを Suspense に伝える (ADR 0035)。
   * boundary 単位 hydrate (= range 経由) では false にして、内側 Suspense は
   * 通常 client mode で children を評価する。
   */
  streaming?: boolean;
  /**
   * boundary 単位 hydrate 用の range 指定 (ADR 0035 B-α)。`<!--vb-${id}-start-->`
   * と `<!--vb-${id}-end-->` の comment Node を渡すと、cursor は range 内のみを
   * post-order で walk する。fragment append skip 判定 (target.contains()) は
   * range の親要素 (= target) を起点に行う。
   */
  range?: { start: Node; end: Node };
};

/**
 * target を hydrate するための Renderer instance を作る。target は SSR で焼かれた
 * markup を含んでいる前提。以降この renderer 経由で h() / appendChild / applyProp
 * が呼ばれると、target の既存 Node に effect / event listener が attach される。
 *
 * options.range が渡された場合、cursor は range 内 subtree のみを walk する
 * (boundary 単位 hydrate、ADR 0035)。
 */
export function createHydrationRenderer(
  target: Element,
  options?: CreateHydrationRendererOptions,
): HydrationRenderer {
  const queue = options?.range
    ? postOrderNodesOfRange(options.range.start, options.range.end)
    : postOrderNodesOfRoot(target);
  let i = 0;

  const consume = (predicate: (n: Node) => boolean, label: string): Node => {
    if (i >= queue.length) {
      throw new Error(`[hydrate] cursor exhausted while expecting ${label}`);
    }
    const node = queue[i]!;
    if (!predicate(node)) {
      throw new Error(
        `[hydrate] cursor mismatch: expected ${label}, got ${describeNode(node)} at index ${i}`,
      );
    }
    i++;
    return node;
  };

  return {
    streaming: options?.streaming === true,
    skipToComment(value: string): void {
      while (i < queue.length) {
        const n = queue[i]!;
        if (n.nodeType === Node.COMMENT_NODE && (n as Comment).nodeValue === value) {
          // cursor は end marker そのものを指している。次の createComment で消費される。
          return;
        }
        i++;
      }
      throw new Error(`[hydrate] skipToComment: marker "${value}" not found`);
    },
    isNode(value): value is Node {
      return typeof Node !== "undefined" && value instanceof Node;
    },
    createElement(tag) {
      const node = consume(
        (n) =>
          n.nodeType === Node.ELEMENT_NODE &&
          (n as Element).tagName.toLowerCase() === tag.toLowerCase(),
        `<${tag}>`,
      );
      return node as Element;
    },
    createText(value) {
      const node = consume((n) => n.nodeType === Node.TEXT_NODE, `text "${value}"`);
      const text = node as Text;
      if (text.data !== value) {
        console.warn(`[hydrate] text mismatch: expected "${value}", got "${text.data}"`);
        text.data = value;
      }
      return text;
    },
    createFragment() {
      // SSR HTML に fragment は無い (中身が直接 serialize される)。client は通常通り
      // DocumentFragment を新規作成し、children を集約する用途で使う。親に
      // appendChild されても DOM は既に連結済みなので no-op (下記 appendChild)。
      return document.createDocumentFragment();
    },
    createComment(value) {
      const node = consume(
        (n) => n.nodeType === Node.COMMENT_NODE,
        value ? `<!--${value}-->` : "comment",
      );
      return node;
    },
    appendChild(parent, child) {
      // 新規 DocumentFragment への append のみ実行。既存 target 内 Node 同士の
      // append は DOM がすでに連結されているので skip (不要な mutation を避ける)。
      //
      // ADR 0021: anchor + fragment 系 primitive (ErrorBoundary 等) では、
      // children を先に renderer 経由で評価してから新規 fragment に append する
      // 構造になっている。この時点で child は既に target subtree 内 (cursor 経由
      // で取得した既存 Node)。これを fragment.appendChild で動かすと target から
      // 外れてしまうので、target.contains(child) なら skip する (元の DOM 位置を
      // 維持)。range 指定時も target は range の親要素を渡すので、target.contains()
      // で range 内 Node かを検出できる。
      if (parent.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
        if (target.contains(child)) return;
        parent.appendChild(child);
      }
    },
    setAttribute(el, key, value) {
      if (el.getAttribute(key) === value) return;
      el.setAttribute(key, value);
    },
    removeAttribute(el, key) {
      if (!el.hasAttribute(key)) return;
      el.removeAttribute(key);
    },
    setProperty(el, key, value) {
      // value / checked / selected は SSR HTML に埋まらない live state。
      // 一致判定せず idempotent に上書き。
      (el as unknown as Record<string, unknown>)[key] = value ?? "";
    },
    setClassName(el, value) {
      if ((el as HTMLElement).className === value) return;
      (el as HTMLElement).className = value;
    },
    assignStyle(el, style) {
      Object.assign((el as HTMLElement).style, style);
    },
    setText(textNode, value) {
      if (textNode.data === value) return;
      textNode.data = value;
    },
    addEventListener(el, type, handler) {
      el.addEventListener(type, handler);
    },
  };
}
