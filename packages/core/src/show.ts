import { effect } from "./effect";
import { onCleanup } from "./owner";
import { readReactiveSource, type ReactiveSource } from "./reactive-source";
import { getRenderer } from "./renderer";

type ShowProps = {
  /**
   * 真偽値、Signal<unknown>、`() => unknown` の 3 形式を受ける (ADR 0039)。
   * Signal / 関数なら effect 内で auto subscribe され、変化に追従する。
   */
  when: ReactiveSource<unknown>;
  // 公開型は Node または `() => Node` の union。TS 的には JSX `<Show>{<Y/>}</Show>` の
  // children は Node (JSX.Element = Node)、手書きで `() => node` を渡すなら関数型。
  // runtime では transform が JSX child を `() => Node` に thunk 化するため、内部は
  // 関数 / Node 両対応で扱う (callOrUse helper)。
  children?: Node | (() => Node);
  fallback?: Node | (() => Node);
};

// children / fallback は transform 経由なら () => Node、手書きなら Node が来る。
// 関数なら呼ぶ、Node ならそのまま使う。null/undefined は null として扱う。
function callOrUse(c: unknown): Node | null {
  if (c == null) return null;
  if (typeof c === "function") return (c as () => Node)();
  return c as Node;
}

/**
 * 条件分岐 primitive。when の真偽に応じて children / fallback を切り替える。
 *
 * children / fallback は **getter** (`() => Node`) で受け取る (ADR 0025、B-4)。
 * active branch のみ呼ばれる = inactive branch は eager 評価されない → SSR markup
 * の active 1 個と client cursor の評価が一致 → 完全 hydrate 達成。
 *
 * `when` は proxy 経由で effect 内から毎回読むので、A 方式 transform で wrap された
 * `{cond}` がそのまま reactive に追従する。
 *
 * Node identity 保持 (state 維持) は **getter 側の責務**: closure で同じ Node を
 * 返せば identity 保持される。JSX 経由 (`<Show>{<Foo />}</Show>` → transform で
 * `() => h(Foo)`) は呼ぶたび新 instance になり、Solid と同じ「toggle で再構築」
 * 挙動になる。手書きで `() => preBuiltNode` を渡せば identity 保持できる。
 *
 * server / client / hydrate 共通の renderer 経由 (ADR 0022, 0025):
 *   - server: when を sync 評価 → active branch getter のみ呼ぶ + `<!--show-->` anchor
 *   - client (mount): 初期 active branch getter を呼んで fragment に append、
 *     effect 初回は skip
 *   - client (hydrate): 同 flow が HydrationRenderer 上で動く
 */
export function Show(props: ShowProps): Node {
  const renderer = getRenderer();

  // server mode: when を sync 評価 → active getter のみ呼んで fragment に組み立て。
  if (renderer.isServer) {
    const whenValue = readReactiveSource(props.when);
    const active = whenValue ? callOrUse(props.children) : callOrUse(props.fallback);
    const fragment = renderer.createFragment();
    if (active !== null) renderer.appendChild(fragment, active);
    renderer.appendChild(fragment, renderer.createComment("show"));
    return fragment;
  }

  // --- client mode (mount / hydrate 共通、renderer 経由) ---
  // initial state を effect の前に sync 評価。active getter 1 つだけ呼ぶ。
  const initialWhen = readReactiveSource(props.when);
  const initialActive = initialWhen ? callOrUse(props.children) : callOrUse(props.fallback);

  const anchor = renderer.createComment("show");
  const fragment = renderer.createFragment();
  if (initialActive !== null) renderer.appendChild(fragment, initialActive);
  renderer.appendChild(fragment, anchor);

  let currentBranch: Node | null = initialActive;
  // 初回 toggle で props.children() を呼ばないよう、initial で「children 側にいる」
  // 状態を boolean で記憶。Node identity 比較だと毎回新 Node を返す getter (JSX 経由)
  // で常に swap が起きてしまうため、論理的な branch (children / fallback) で判定する。
  let onChildren = !!initialWhen;

  // effect 初回 invocation は initial state を二重 setup しないよう skip。
  // dependency (when) は effect body 内で読まれるため subscribe される。
  let initialEffect = true;
  effect(() => {
    const whenValue = readReactiveSource(props.when);
    const nextOnChildren = !!whenValue;

    if (initialEffect) {
      initialEffect = false;
      return;
    }

    if (nextOnChildren === onChildren) return;

    if (currentBranch !== null) {
      currentBranch.parentNode?.removeChild(currentBranch);
      currentBranch = null;
    }

    const next = nextOnChildren ? callOrUse(props.children) : callOrUse(props.fallback);
    if (next !== null) {
      anchor.parentNode?.insertBefore(next, anchor);
    }
    currentBranch = next;
    onChildren = nextOnChildren;
  });

  onCleanup(() => {
    currentBranch?.parentNode?.removeChild(currentBranch);
    anchor.parentNode?.removeChild(anchor);
  });

  return fragment;
}
