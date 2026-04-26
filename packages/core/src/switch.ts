import { effect } from "./effect";
import { onCleanup } from "./owner";
import { getRenderer } from "./renderer";

// Match が返す内部 descriptor の識別。Switch が children を走査する際、
// Match 以外の Node が混ざってないか判別するために使う。
const MATCH_SYMBOL = Symbol("vidro.match");

type MatchDescriptor = {
  readonly [MATCH_SYMBOL]: true;
  /** Switch の effect 内から呼ぶ。props を毎回 proxy 経由で読むため関数で包む。 */
  readonly readWhen: () => unknown;
  readonly child: Node | null;
};

type MatchProps = {
  when: unknown;
  children?: Node;
};

/**
 * <Switch> 内の分岐を表す marker。Match 自体は DOM を作らず、親 Switch が走査で
 * 参照する descriptor を返す。Switch の外で直接使うと何も表示されない。
 *
 * `when` は proxy で読むたび評価される (= reactive) が、descriptor 上では readWhen
 * 関数で包んで Switch の effect 内から毎回読み直せるようにする。値コピー保存だと
 * 初回評価で固定されて再評価されない。
 */
export function Match(props: MatchProps): Node {
  const descriptor: MatchDescriptor = {
    [MATCH_SYMBOL]: true,
    readWhen: () => props.when,
    child: props.children ?? null,
  };
  return descriptor as unknown as Node;
}

type SwitchProps = {
  children?: Node | Node[];
  fallback?: Node;
};

/**
 * 多分岐 primitive。Match children を順に評価し、when が真になった最初の 1 つの
 * child を mount する (早い者勝ち)。全て false なら fallback (あれば)。
 *
 * server / client / hydrate 共通の renderer 経由 (ADR 0023):
 *   - server: 各 Match の readWhen を sync 評価 → active child + `<!--switch-->`
 *     anchor を返す (inactive Match の child は捨てる)
 *   - client (mount): 初期 active を fragment に append、effect 初回は skip
 *   - client (hydrate): 同 flow が HydrationRenderer 上で動く
 *
 * **B-3c-3 の制約**: Match の child / fallback は h() 引数評価で **すべて** eager
 * 評価されるため、複数 Match の children が常に作られる。SSR markup には active
 * 1 つしか出ないので、`<Switch>` を持つ subtree の hydrate は cursor mismatch する
 * (`Switch` 自身は anchor を吐くが内部の inactive children が cursor 過剰消費)。
 * 完全な hydrate 対応には B-4 (children getter 化) が必要。本 ADR では構造変更のみ。
 */
export function Switch(props: SwitchProps): Node {
  const matches = collectMatches(props.children);
  const renderer = getRenderer();

  // server mode: 各 Match の when を sync 評価 → active child + anchor を返す。
  // 全 false なら fallback、それも無ければ anchor のみ。
  if (renderer.isServer) {
    let active: Node | null = null;
    for (const m of matches) {
      const w = m.readWhen();
      const v = typeof w === "function" ? (w as () => unknown)() : w;
      if (v) {
        active = m.child;
        break;
      }
    }
    active ??= props.fallback ?? null;
    const fragment = renderer.createFragment();
    if (active !== null) renderer.appendChild(fragment, active);
    renderer.appendChild(fragment, renderer.createComment("switch"));
    return fragment;
  }

  // --- client mode (mount / hydrate 共通、renderer 経由) ---
  // initial active を effect の前に sync 評価して fragment を組む。
  let initialActive: Node | null = null;
  for (const m of matches) {
    const w = m.readWhen();
    const v = typeof w === "function" ? (w as () => unknown)() : w;
    if (v) {
      initialActive = m.child;
      break;
    }
  }
  initialActive ??= props.fallback ?? null;

  const anchor = renderer.createComment("switch");
  const fragment = renderer.createFragment();
  if (initialActive !== null) renderer.appendChild(fragment, initialActive);
  renderer.appendChild(fragment, anchor);

  let currentBranch: Node | null = initialActive;

  // effect 初回 invocation は initial state setup 済みのため skip。dependency
  // (各 Match の when) は effect body 内で readWhen() 経由で読まれるため subscribe
  // される。signal の変化で 2 回目以降 invocation が本来の切替 logic に入る。
  let initialEffect = true;
  effect(() => {
    let next: Node | null = null;
    for (const m of matches) {
      if (m.readWhen()) {
        next = m.child;
        break;
      }
    }
    next ??= props.fallback ?? null;

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

// children から MATCH_SYMBOL 付き descriptor だけを抜き出す。
function collectMatches(children: SwitchProps["children"]): MatchDescriptor[] {
  if (children == null) return [];
  const list = Array.isArray(children) ? children : [children];
  const result: MatchDescriptor[] = [];
  for (const c of list) {
    if (isMatchDescriptor(c)) result.push(c);
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
