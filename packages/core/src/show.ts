import { effect } from "./effect";
import { onCleanup } from "./owner";
import { getRenderer } from "./renderer";

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
 *
 * server / client / hydrate 共通の renderer 経由 (ADR 0022):
 *   - server: when を sync 評価 → active branch + `<!--show-->` anchor を返す
 *     (inactive branch は捨てる)
 *   - client (mount): 初期 active branch を fragment に append、effect 初回は skip
 *   - client (hydrate): 同 flow が HydrationRenderer 上で動く。createComment が
 *     SSR で吐かれた `<!--show-->` を cursor から消費する
 *
 * **B-3c-2 の制約**: children と fallback は h() 引数評価で **両方** eager 評価
 * されるため、`<Show fallback={<X />}>{<Y />}</Show>` のような hydrate は cursor
 * mismatch する (server markup には active 1 つしか出ない)。完全な hydrate 対応
 * には B-4 (children getter 化) が必要。本 ADR では構造変更のみ。
 */
export function Show(props: ShowProps): Node {
  const renderer = getRenderer();

  // server mode: when を sync 評価 → active branch + anchor を fragment に組み立て。
  // proxy 経由 effect 不要 (server は再レンダしない)。
  if (renderer.isServer) {
    const whenValue =
      typeof props.when === "function" ? (props.when as () => unknown)() : props.when;
    const active = (whenValue ? props.children : props.fallback) ?? null;
    const fragment = renderer.createFragment();
    if (active !== null) renderer.appendChild(fragment, active);
    renderer.appendChild(fragment, renderer.createComment("show"));
    return fragment;
  }

  // --- client mode (mount / hydrate 共通、renderer 経由) ---
  // initial state を effect の前に sync 評価して fragment を組む。renderer の cursor
  // 順 (active の中身 → active → anchor) と JSX 評価順を一致させるため、active branch
  // (children か fallback) は呼び出し側で既に評価済み (props として渡ってくる)。
  // ここでは active を選んで fragment に append、anchor も append する。
  const initialWhen =
    typeof props.when === "function" ? (props.when as () => unknown)() : (props.when as unknown);
  const initialActive = (initialWhen ? props.children : props.fallback) ?? null;

  const anchor = renderer.createComment("show");
  const fragment = renderer.createFragment();
  if (initialActive !== null) renderer.appendChild(fragment, initialActive);
  renderer.appendChild(fragment, anchor);

  let currentBranch: Node | null = initialActive;

  // effect 初回 invocation は initial state を二重 setup しないよう skip。
  // dependency (when) は effect body 内で読まれるため subscribe される。signal の
  // 変化で 2 回目以降 invocation が本来の切替 logic に入る。
  let initialEffect = true;
  effect(() => {
    const whenValue =
      typeof props.when === "function" ? (props.when as () => unknown)() : props.when;
    const next = (whenValue ? props.children : props.fallback) ?? null;

    if (initialEffect) {
      initialEffect = false;
      return;
    }

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
