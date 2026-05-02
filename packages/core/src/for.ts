import { effect } from "./effect";
import { onCleanup, Owner } from "./owner";
import { readReactiveSource, type ReactiveSource } from "./reactive-source";
import { getRenderer } from "./renderer";

type ForProps<T> = {
  /**
   * 配列、Signal<T[]>、`() => T[]` の 3 形式を受ける (ADR 0039 reactive-source)。
   * Signal / 関数なら effect 内で auto subscribe され、変化に追従する。
   */
  each: ReactiveSource<T[]>;
  children: (item: T, index: number) => Node;
  // 公開型は Node または `() => Node`。JSX `<For fallback={<X />}>` も手書き
  // `fallback: () => node` も許容。runtime で transform は JSXElement attribute を
  // `() => h(X)` に thunk 化する (callOrUseFallback helper で吸収)。
  fallback?: Node | (() => Node);
};

// fallback は transform 経由なら () => Node、手書きなら Node が来る。
function callOrUseFallback(c: unknown): Node | null {
  if (c == null) return null;
  if (typeof c === "function") return (c as () => Node)();
  return c as Node;
}

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
 * server / client / hydrate 共通の renderer 経由 (ADR 0024 / 0025):
 *   - server: each を sync 評価 → 各 item に children() 呼んで Node 作る +
 *     `<!--for-->` anchor。each 空なら fallback() を呼ぶ
 *   - client (mount): 初期 entries を effect 前に sync 構築、effect 初回は skip
 *   - client (hydrate): 同 flow が HydrationRenderer 上で動く
 *
 * fallback は **getter** (`() => Node`) で受ける (ADR 0025、B-4)。each 空の時のみ
 * 呼ばれ、list 非空ケースの cursor 過剰消費問題が解消する。
 */
export function For<T>(props: ForProps<T>): Node {
  const renderer = getRenderer();

  // server mode: each を sync 評価 → 各 item を children() で Node 化 + anchor。
  // 空リストなら fallback getter を呼ぶ、それも無ければ anchor のみ。
  if (renderer.isServer) {
    const list = readReactiveSource(props.each);
    const fragment = renderer.createFragment();
    if (list.length === 0) {
      const fb = callOrUseFallback(props.fallback);
      if (fb) renderer.appendChild(fragment, fb);
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
  const initialList = readReactiveSource(props.each);
  if (initialList.length === 0) {
    const fb = callOrUseFallback(props.fallback);
    if (fb) {
      fallbackNode = fb;
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
    // readReactiveSource で 3 形式 (T[] / Signal<T[]> / () => T[]) を吸収。
    // Signal / 関数なら effect の observer に subscribe され、変化に追従する。
    const list = readReactiveSource(props.each);
    // 初回 invocation でも `list.length` を読んで dependency を登録する。これがないと
    // each に **store array proxy を直接渡した場合** (= 関数 / Signal を介さない、
    // plain T として readReactiveSource を素通り) に subscribe が一度も成立せず、
    // 後続の splice / push などでも effect が再 fire しない (ADR 0049 / 0053 dogfood
    // で発覚)。array proxy の length access は length / structure 両方を track する
    // ので、要素入れ替え (length 不変) も拾える。
    void list.length;
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
      if (fallbackNode === null && parent) {
        const fb = callOrUseFallback(props.fallback);
        if (fb) {
          fallbackNode = fb;
          parent.insertBefore(fallbackNode, anchor);
        }
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
