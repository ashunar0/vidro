import { effect } from "./effect";
import { Signal } from "./signal";
import { onCleanup } from "./owner";

type ShowProps<T> = {
  when: Signal<T> | (() => T) | T;
  children?: Node;
  fallback?: Node;
};

/**
 * 条件分岐 primitive。when の真偽に応じて children / fallback を切り替える。
 *
 * children / fallback は invoke-once で評価済みの Node として受け取り、切替時は
 * 同じ Node を attach / detach するだけ (state 保持)。毎回 rebuild したい場合は
 * 上位で関数 children を使う別手段を用意する想定。
 *
 * 戻り値は DocumentFragment + 中に Comment アンカー。親に append された時点で
 * anchor が親 DOM に移り、その周辺を branch の入れ替え領域として使う。
 */
export function Show<T>(props: ShowProps<T>): Node {
  const anchor = document.createComment("show");
  const fragment = document.createDocumentFragment();
  fragment.appendChild(anchor);

  let currentBranch: Node | null = null;

  effect(() => {
    const cond = readWhen(props.when);
    const next = (cond ? props.children : props.fallback) ?? null;

    if (currentBranch === next) return;

    if (currentBranch !== null) {
      currentBranch.parentNode?.removeChild(currentBranch);
    }

    if (next !== null) {
      anchor.parentNode?.insertBefore(next, anchor);
    }

    currentBranch = next;
  });

  // 親 Owner (mount / 上位 component) が dispose される際に、挿入した anchor と
  // 現在の branch を DOM から外す。Effect の dispose だけでは DOM は残るため。
  onCleanup(() => {
    currentBranch?.parentNode?.removeChild(currentBranch);
    anchor.parentNode?.removeChild(anchor);
  });

  return fragment;
}

// when の 3 形式 (Signal / 関数 / プレーン値) を一本化して読む。Effect 内で呼ばれるので
// Signal.value と function() はどちらも依存追跡に乗る。A 方式 transform で `{signal}` が
// `() => signal` に包まれた場合、関数呼び出しの返り値が Signal instance になるので unwrap。
function readWhen<T>(when: Signal<T> | (() => T) | T): T {
  if (when instanceof Signal) return when.value;
  if (typeof when === "function") {
    const result = (when as () => T)();
    if (result instanceof Signal) return result.value as T;
    return result;
  }
  return when;
}
