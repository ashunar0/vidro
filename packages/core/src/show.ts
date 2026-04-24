import { effect } from "./effect";
import { onCleanup } from "./owner";

type ShowProps = {
  when: unknown;
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
 * `when` は proxy 経由で effect 内から毎回読むので、A 方式 transform で wrap された
 * `{cond}` がそのまま reactive に追従する (値コピーは禁止)。
 */
export function Show(props: ShowProps): Node {
  const anchor = document.createComment("show");
  const fragment = document.createDocumentFragment();
  fragment.appendChild(anchor);

  let currentBranch: Node | null = null;

  effect(() => {
    const next = (props.when ? props.children : props.fallback) ?? null;

    if (currentBranch === next) return;

    if (currentBranch !== null) {
      currentBranch.parentNode?.removeChild(currentBranch);
    }

    if (next !== null) {
      anchor.parentNode?.insertBefore(next, anchor);
    }

    currentBranch = next;
  });

  onCleanup(() => {
    currentBranch?.parentNode?.removeChild(currentBranch);
    anchor.parentNode?.removeChild(anchor);
  });

  return fragment;
}
