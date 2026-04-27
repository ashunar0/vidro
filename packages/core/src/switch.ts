import { effect } from "./effect";
import { onCleanup } from "./owner";
import { readReactiveSource, type ReactiveSource } from "./reactive-source";
import { getRenderer } from "./renderer";

// Match が返す内部 descriptor の識別。Switch が children を走査する際、
// Match 以外の Node が混ざってないか判別するために使う。
const MATCH_SYMBOL = Symbol("vidro.match");

type MatchDescriptor = {
  readonly [MATCH_SYMBOL]: true;
  /**
   * Switch の effect 内から呼ぶ。3 形式 (T / Signal<T> / () => T) を毎回 resolve するので、
   * Signal / 関数 なら effect の observer に subscribe される。
   */
  readonly readWhen: () => unknown;
  /** active になった時のみ Switch 側で呼んで Node を取得 (ADR 0025、B-4 getter 化)。 */
  readonly readChild: () => Node | null;
};

type MatchProps = {
  /**
   * 真偽値、Signal<unknown>、`() => unknown` の 3 形式を受ける (ADR 0039)。
   * Signal / 関数なら Switch の effect 内で auto subscribe される。
   */
  when: ReactiveSource<unknown>;
  // 公開型は Node または `() => Node` の union。TS 的には JSX `<Match>{<Y/>}</Match>` の
  // children は Node、手書きで `() => node` を渡すなら関数型。runtime では transform
  // が JSX child を `() => Node` に thunk 化する (callOrUse helper で吸収)。
  children?: Node | (() => Node);
};

// children / fallback は transform 経由なら () => Node、手書きなら Node が来る。
function callOrUse(c: unknown): Node | null {
  if (c == null) return null;
  if (typeof c === "function") return (c as () => Node)();
  return c as Node;
}

/**
 * <Switch> 内の分岐を表す marker。Match 自体は DOM を作らず、親 Switch が走査で
 * 参照する descriptor を返す。Switch の外で直接使うと何も表示されない。
 *
 * `children` は **getter** (`() => Node`) で受け取り、Switch 側で active になった
 * Match のみ child を呼ぶ (ADR 0025)。inactive Match の children は評価されない。
 */
export function Match(props: MatchProps): Node {
  const descriptor: MatchDescriptor = {
    [MATCH_SYMBOL]: true,
    readWhen: () => readReactiveSource(props.when),
    readChild: () => callOrUse(props.children),
  };
  return descriptor as unknown as Node;
}

type SwitchProps = {
  /** transform 経由なら `() => MatchDescriptor` の配列、手書きなら descriptor 直 / 配列 */
  children?: unknown;
  fallback?: Node | (() => Node);
};

/**
 * 多分岐 primitive。Match children を順に評価し、when が真になった最初の 1 つの
 * child を mount する (早い者勝ち)。全て false なら fallback (あれば)。
 *
 * children / fallback は **getter** で受け取る (ADR 0025、B-4):
 *   - children は `() => MatchDescriptor` の配列 (transform 経由) もしくは
 *     descriptor 直渡し / 配列 (手書き)。collectMatches で全パターンを吸収
 *   - fallback は `() => Node` で active Match 無し時のみ呼ぶ
 *   - Match descriptor の readChild は active になった時のみ呼ばれる
 *
 * server / client / hydrate 共通の renderer 経由 (ADR 0023, 0025)。
 */
export function Switch(props: SwitchProps): Node {
  const matches = collectMatches(props.children);
  const renderer = getRenderer();

  // server mode: 各 Match の when を sync 評価 → active の readChild + anchor を返す。
  // 全 false なら fallback、それも無ければ anchor のみ。
  if (renderer.isServer) {
    let active: Node | null = null;
    for (const m of matches) {
      // readWhen は ReactiveSource を resolve 済みの値を返す (Match 内部で readReactiveSource 経由)
      if (m.readWhen()) {
        active = m.readChild();
        break;
      }
    }
    active ??= callOrUse(props.fallback);
    const fragment = renderer.createFragment();
    if (active !== null) renderer.appendChild(fragment, active);
    renderer.appendChild(fragment, renderer.createComment("switch"));
    return fragment;
  }

  // --- client mode (mount / hydrate 共通、renderer 経由) ---
  let initialActiveIndex = -1;
  for (let i = 0; i < matches.length; i++) {
    if (matches[i]!.readWhen()) {
      initialActiveIndex = i;
      break;
    }
  }
  const initialActive =
    initialActiveIndex >= 0 ? matches[initialActiveIndex]!.readChild() : callOrUse(props.fallback);

  const anchor = renderer.createComment("switch");
  const fragment = renderer.createFragment();
  if (initialActive !== null) renderer.appendChild(fragment, initialActive);
  renderer.appendChild(fragment, anchor);

  let currentBranch: Node | null = initialActive;
  // active Match の index を記憶 (-1 = fallback)。Node identity ではなく index で
  // 判定することで、毎回新 Node を返す getter でも誤 swap を起こさない。
  let activeIndex = initialActiveIndex;

  let initialEffect = true;
  effect(() => {
    let nextIndex = -1;
    for (let i = 0; i < matches.length; i++) {
      if (matches[i]!.readWhen()) {
        nextIndex = i;
        break;
      }
    }

    if (initialEffect) {
      initialEffect = false;
      return;
    }

    if (nextIndex === activeIndex) return;

    if (currentBranch !== null) {
      currentBranch.parentNode?.removeChild(currentBranch);
      currentBranch = null;
    }

    const next = nextIndex >= 0 ? matches[nextIndex]!.readChild() : callOrUse(props.fallback);
    if (next !== null) {
      anchor.parentNode?.insertBefore(next, anchor);
    }
    currentBranch = next;
    activeIndex = nextIndex;
  });

  onCleanup(() => {
    currentBranch?.parentNode?.removeChild(currentBranch);
    anchor.parentNode?.removeChild(anchor);
  });

  return fragment;
}

// children を走査して MatchDescriptor だけを抜き出す。transform 経由 (`() =>
// MatchDescriptor` の配列 / 単一) と手書き (descriptor 直 / 配列) を吸収する。
function collectMatches(children: unknown): MatchDescriptor[] {
  if (children == null) return [];
  const list = Array.isArray(children) ? children : [children];
  const result: MatchDescriptor[] = [];
  for (const c of list) {
    const value = typeof c === "function" ? (c as () => unknown)() : c;
    if (isMatchDescriptor(value)) result.push(value);
  }
  return result;
}

function isMatchDescriptor(value: unknown): value is MatchDescriptor {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[MATCH_SYMBOL] === true
  );
}
