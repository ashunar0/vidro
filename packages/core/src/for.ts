import { effect } from "./effect";
import { onCleanup, Owner } from "./owner";

type ForProps<T> = {
  each: T[];
  children: (item: T, index: number) => Node;
  fallback?: Node;
};

/**
 * リスト primitive。each の配列を keyed reconciliation で DOM に反映する。
 *
 * item の参照 identity を key として Map で管理し、残った item は同じ DOM と
 * child Owner を再利用する (state 保持)。消えた item は Owner を dispose して
 * 配下の Effect を解放。並び替えは anchor の前への insertBefore 連打で実現
 * (LIS 最適化は未、並び替え多発時は DOM 操作コスト高め)。
 *
 * index は children を最初に呼んだ時点の値で固定 (reactive index は未対応)。
 */
export function For<T>(props: ForProps<T>): Node {
  const anchor = document.createComment("for");
  const fragment = document.createDocumentFragment();
  fragment.appendChild(anchor);

  // item (参照) → DOM node / child Owner。next list 構築時に移し替え、残りを dispose
  let entries = new Map<T, { node: Node; owner: Owner }>();
  let fallbackNode: Node | null = null;

  effect(() => {
    // props.each は proxy 経由で毎回評価 (A 方式 transform で wrap された `{list}` が
    // ここで展開され、signal の変化に追従する)
    const list = props.each;
    const parent = anchor.parentNode;

    // 空リスト: 全 entry 掃除 + fallback 挿入
    if (list.length === 0) {
      for (const { node, owner } of entries.values()) {
        node.parentNode?.removeChild(node);
        owner.dispose();
      }
      entries.clear();
      if (props.fallback && fallbackNode === null && parent) {
        fallbackNode = props.fallback;
        parent.insertBefore(fallbackNode, anchor);
      }
      return;
    }

    // 非空に戻った: fallback を外す
    if (fallbackNode !== null) {
      fallbackNode.parentNode?.removeChild(fallbackNode);
      fallbackNode = null;
    }

    const nextEntries = new Map<T, { node: Node; owner: Owner }>();
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      const existing = entries.get(item);
      if (existing) {
        nextEntries.set(item, existing);
        entries.delete(item);
      } else {
        const owner = new Owner(null);
        const node = owner.run(() => props.children(item, i));
        nextEntries.set(item, { node, owner });
      }
    }

    // entries に残った = next に含まれない item。DOM 除去 + owner dispose
    for (const { node, owner } of entries.values()) {
      node.parentNode?.removeChild(node);
      owner.dispose();
    }

    // next 順で anchor の前に挿入 (既存 node は "move"、新規は新たに入る)
    if (parent !== null) {
      for (const { node } of nextEntries.values()) {
        parent.insertBefore(node, anchor);
      }
    }

    entries = nextEntries;
  });

  onCleanup(() => {
    for (const { node, owner } of entries.values()) {
      node.parentNode?.removeChild(node);
      owner.dispose();
    }
    fallbackNode?.parentNode?.removeChild(fallbackNode);
    anchor.parentNode?.removeChild(anchor);
  });

  return fragment;
}
