import { effect } from "./effect";
import { onCleanup } from "./owner";

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
 */
export function Switch(props: SwitchProps): Node {
  const matches = collectMatches(props.children);
  const anchor = document.createComment("switch");
  const fragment = document.createDocumentFragment();
  fragment.appendChild(anchor);

  let currentBranch: Node | null = null;

  effect(() => {
    let next: Node | null = null;
    for (const m of matches) {
      if (m.readWhen()) {
        next = m.child;
        break;
      }
    }
    next ??= props.fallback ?? null;

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
