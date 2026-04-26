import { effect } from "./effect";
import { onCleanup, Owner } from "./owner";
import { getRenderer } from "./renderer";

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
 *
 * server / client / hydrate 共通の renderer 経由 (ADR 0024):
 *   - server: each を sync 評価 → 各 item に children() 呼んで Node 作る +
 *     `<!--for-->` anchor。each 空なら fallback。children は元々関数なので
 *     遅延評価で問題ない (Show / Switch と違って inactive children 問題が無い)
 *   - client (mount): 初期 entries を effect 前に sync 構築、effect 初回は skip
 *   - client (hydrate): 同 flow が HydrationRenderer 上で動く
 *
 * **B-3c-4 の制約**: `fallback` は h() 引数評価で eager 評価される。`<For each={list}
 * fallback={<X />}>` で list が非空のとき、fallback Node も作られて cursor 過剰
 * 消費 → mismatch する。完全な hydrate 対応には B-4 (children getter 化) で
 * fallback も `() => Node` 化する必要がある。本 ADR では構造変更のみ。
 */
export function For<T>(props: ForProps<T>): Node {
  const renderer = getRenderer();

  // server mode: each を sync 評価 → 各 item を children() で Node 化 + anchor。
  // 空リストなら fallback、それも無ければ anchor のみ。
  if (renderer.isServer) {
    const list = props.each;
    const fragment = renderer.createFragment();
    if (list.length === 0) {
      if (props.fallback) renderer.appendChild(fragment, props.fallback);
    } else {
      for (let i = 0; i < list.length; i++) {
        const item = list[i]!;
        const node = props.children(item, i);
        renderer.appendChild(fragment, node);
      }
    }
    renderer.appendChild(fragment, renderer.createComment("for"));
    return fragment;
  }

  // --- client mode (mount / hydrate 共通、renderer 経由) ---
  // initial entries を effect の前に sync 構築。各 item に対して child Owner を
  // 立てて children(item, i) を評価し、Map に格納。fragment にも順番に append。
  // renderer の cursor 順 (item1 中身 → item1 → item2 中身 → ... → anchor) と
  // JSX 評価順を一致させる。
  let entries = new Map<T, { node: Node; owner: Owner }>();
  let fallbackNode: Node | null = null;

  const fragment = renderer.createFragment();
  const initialList = props.each;
  if (initialList.length === 0) {
    if (props.fallback) {
      fallbackNode = props.fallback;
      renderer.appendChild(fragment, fallbackNode);
    }
  } else {
    for (let i = 0; i < initialList.length; i++) {
      const item = initialList[i]!;
      const owner = new Owner(null);
      const node = owner.run(() => props.children(item, i));
      entries.set(item, { node, owner });
      renderer.appendChild(fragment, node);
    }
  }

  const anchor = renderer.createComment("for");
  renderer.appendChild(fragment, anchor);

  // effect 初回 invocation は initial state setup 済みのため skip。
  // dependency (props.each) は effect body 内で読まれるため subscribe される。
  // signal の変化で 2 回目以降 invocation が本来の reconciliation logic に入る。
  let initialEffect = true;
  effect(() => {
    // props.each は proxy 経由で毎回評価 (A 方式 transform で wrap された `{list}` が
    // ここで展開され、signal の変化に追従する)
    const list = props.each;
    if (initialEffect) {
      initialEffect = false;
      return;
    }

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
