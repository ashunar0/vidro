import { effect } from "./effect";
import { Signal } from "./signal";
import { onCleanup } from "./owner";

// Match が返す内部 descriptor の識別。Switch が children を走査する際、
// Match 以外の Node が混ざってないか判別するために使う。
const MATCH_SYMBOL = Symbol("vidro.match");

type MatchDescriptor = {
  readonly [MATCH_SYMBOL]: true;
  readonly when: unknown;
  readonly child: Node | null;
};

type MatchProps<T> = {
  when: Signal<T> | (() => T) | T;
  children?: Node;
};

/**
 * <Switch> 内の分岐を表す marker。Match 自体は DOM を作らず、親 Switch が走査で
 * 参照する descriptor を返す。Switch の外で直接使うと何も表示されない (descriptor
 * が Node 扱いで処理されて黙って落ちる) ので、必ず Switch の子として使う。
 *
 * 戻り値は型上は Node (JSX.Element 互換) だが、実体は descriptor object。Switch が
 * MATCH_SYMBOL で識別して中身を取り出す。
 */
export function Match<T>(props: MatchProps<T>): Node {
  const descriptor: MatchDescriptor = {
    [MATCH_SYMBOL]: true,
    when: props.when,
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
 * Show と同じ invoke-once + anchor 方式で、branch swap 時に同じ Node 参照を再利用
 * する (DOM 上の state が保持される)。全 Match の children は呼び出し時点で評価済み
 * なので、表示されない branch の DOM も事前構築される。
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
      if (readWhen(m.when)) {
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

  // 親 Owner の dispose 時に、挿入した anchor と現在の branch を DOM から外す。
  onCleanup(() => {
    currentBranch?.parentNode?.removeChild(currentBranch);
    anchor.parentNode?.removeChild(anchor);
  });

  return fragment;
}

// children から MATCH_SYMBOL 付き descriptor だけを抜き出す。それ以外 (通常 Node や
// primitive) が紛れていたら黙って無視する — Switch の直下に Match 以外を置くのは
// 使い方違反という扱い。
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

// Show.readWhen と同一ロジック。when の 3 形式 (Signal / 関数 / 値) を一本化して読む。
// A 方式 transform で `{expr}` が `() => expr` に包まれるため、関数返り値が Signal
// instance の場合は更に unwrap する (forward-compat)。
function readWhen(when: unknown): unknown {
  if (when instanceof Signal) return when.value;
  if (typeof when === "function") {
    const result = (when as () => unknown)();
    if (result instanceof Signal) return result.value;
    return result;
  }
  return when;
}
