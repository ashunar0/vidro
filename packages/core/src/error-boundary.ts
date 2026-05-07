import { Signal } from "./signal";
import { effect } from "./effect";
import { Owner, getCurrentOwner, onCleanup } from "./owner";
import { untrack } from "./observer";
import { getRenderer } from "./renderer";
import type { VNode } from "./server-renderer";

type ErrorBoundaryProps = {
  /** 捕捉した error を受けて fallback UI を返す。err は throw された値、reset は state 復帰用。 */
  fallback: (err: unknown, reset: () => void) => Node;
  /** 握りつぶし防止のため required。ログ基盤への送出やメトリクス集計はここから行う。 */
  onError: (err: unknown) => void;
  /** JSX 評価順の都合で関数で受け取る — boundary が自分の Owner scope を set した後に評価する必要があるため。
   *  将来 JSX compile transform を Solid 方式に拡張すれば、この制約を消せる (B-4 課題)。 */
  children: () => Node;
};

/**
 * エラー境界 primitive。children 内で発生した throw を catch し、fallback に差し替える。
 *
 * catch 対象:
 *   - 子コンポーネントの初期描画 (関数 component の throw)
 *   - 子 Effect / Computed の再実行時の throw
 *   - 子の onMount コールバックの throw
 *   - event handler (onClick 等) は **対象外** — 画面を壊さない throw は boundary の責務ではない
 *
 * reset: error state を解除し、children owner を dispose → 新 Owner で再 mount。
 *   state は初期化される (Solid 方式)。
 *
 * bubble up: fallback 内で再 throw された場合、fallback owner には handler を付けないので
 *   自動的に親の owner chain (= 外側の ErrorBoundary もしくは root) へ伝播する。
 *
 * server / client / hydrate 共通の renderer 経由 (ADR 0021):
 *   - server: try/catch で content を sync 評価 → fragment + content + `<!--error-boundary-->`
 *     anchor を返す。effect / signal は使わない
 *   - client (mount): mountChildren で初期 content を作ってから fragment に append、
 *     anchor も renderer 経由 → DocumentFragment 経由で DOM に展開
 *   - client (hydrate): 同じ flow が HydrationRenderer 上で動く。createComment が
 *     SSR で吐かれた `<!--error-boundary-->` を cursor から消費する
 */
export function ErrorBoundary(props: ErrorBoundaryProps): Node {
  const renderer = getRenderer();

  // server mode: childrenOwner を立てて setErrorHandler で sync throw / async reject
  // (= ADR 0066 Q6) の両方を catch する。successフラグで多重起動を防ぎ、最初の
  // error だけが fallback markup に反映される。
  //
  // ADR 0066 Phase 4-B (Q6 機構): async function component が return した Promise が
  // reject すると、jsx.ts h() の then-handler が `componentOwner.handleError(err)` を
  // 呼ぶ。componentOwner の親は本 ErrorBoundary の childrenOwner なので chain で
  // setErrorHandler に届く。handler は fragment.children[0] (= contentNode = VAsyncSlot を
  // 含む subtree、または sync 成功 markup) を fallback Node に **mutation** で
  // 書き換える (= Option β、children tree は捨てる)。fragment は ErrorBoundary が
  // return 後も closure で参照を保持しているので serialize 時には mutation 後の
  // children が見える (= invoke-once 維持: tree 1 回 build、slot mutation 1 回)。
  if (renderer.isServer) {
    const fragment = renderer.createFragment();
    const anchor = renderer.createComment("error-boundary");

    const childrenOwner = new Owner();
    let errored = false;

    childrenOwner.setErrorHandler((err) => {
      // 最初の error だけ採用 (= 多重 reject の連鎖で fallback が上書きされ続けるのを防ぐ)。
      if (errored) return;
      errored = true;
      props.onError(err);
      // server では reset 不要 (= 次回 client hydrate で error.value=null から始まる)。
      const fallbackNode = props.fallback(err, () => {}) as unknown as VNode;
      // VFragment は server-renderer で `{ kind: "fragment", children: VNode[] }` 構造。
      // 直接 children を mutation する (= invoke-once + serialize 時には書き換え後の値)。
      const f = fragment as unknown as { children: VNode[] };
      if (f.children.length > 0) {
        // contentNode が既に append されている (sync 成功 + 後続 async reject) → 0 番目 replace
        f.children[0] = fallbackNode;
      } else {
        // contentNode が未 append (sync throw 直後の handler 起動) → 直接 push
        f.children.push(fallbackNode);
      }
    });

    // children を sync 評価。sync throw なら handler が即起動 → fallback が
    // fragment.children に push される + runCatching が undefined を返す。
    // async pending (= 内側に async function component あり) の場合は contentNode が
    // VAsyncSlot を含む subtree として返り、その後 Promise resolve / reject で
    // serialize 直前までに slot.resolved 書き込みまたは handler 起動が走る。
    const contentNode = childrenOwner.runCatching(() => props.children());
    if (contentNode !== undefined && !errored) {
      renderer.appendChild(fragment, contentNode);
    }
    renderer.appendChild(fragment, anchor);
    return fragment;
  }

  // --- client mode (mount / hydrate 共通、renderer 経由、ADR 0021) ---
  const error = new Signal<unknown>(null);
  // ErrorBoundary 関数を呼んだ側の Owner。children / fallback owner の親にする。
  // ここには handler を付けないので bubble up が自然に外側へ抜ける。
  const parentOwner = getCurrentOwner();

  let childrenOwner: Owner | null = null;
  let childrenNode: Node | null = null;
  let fallbackOwner: Owner | null = null;
  let currentBranch: Node | null = null;

  // children owner の error handler。reportError が error state を立て、fallback へ切替を誘発する。
  const reportError = (err: unknown): void => {
    // 既に error state に入っていて再度 throw された場合 (fallback 内の throw など) は
    // 自分で握らず親に伝播させる。bubble up の本体。
    if (error.value !== null) {
      if (parentOwner) parentOwner.handleError(err);
      else throw err;
      return;
    }
    // onError を先に呼ぶ。user handler 内の throw は握りつぶさず外に投げる。
    props.onError(err);
    error.value = err;
  };

  const reset = (): void => {
    error.value = null;
  };

  const mountChildren = (): void => {
    if (childrenOwner) childrenOwner.dispose();
    childrenOwner = new Owner(parentOwner);
    childrenOwner.setErrorHandler(reportError);
    const node = childrenOwner.runCatching(props.children);
    childrenNode = node ?? null;
  };

  // 初回 children を effect の前に同期評価する。renderer 経由で cursor を進めるため、
  // anchor を作る **前** に content を確定する必要がある (cursor は post-order の
  // 順序: content の中身 → anchor)。children() が初期描画で throw した場合は、
  // reportError が error.value を埋めるので、ここで fallback も即同期評価して
  // initial content として埋める (server / hydrate 整合のため、ADR 0021)。
  mountChildren();
  if (error.value !== null) {
    // children throw → effect 内 fallback 経路と同じ後始末 (childrenOwner dispose) を
    // 即実行し、fallback も sync 評価する。reset 経路で childrenOwner === null 判定が
    // 効くようにするため。
    // (childrenOwner は mountChildren() で代入されるが TS flow analysis が関数経由を
    // 追えないので as 再 widen する)
    const co = childrenOwner as Owner | null;
    if (co) {
      co.dispose();
      childrenOwner = null;
      childrenNode = null;
    }
    fallbackOwner = new Owner(parentOwner);
    const fbNode = fallbackOwner.runCatching(() => props.fallback(error.value, reset));
    currentBranch = fbNode ?? null;
  } else {
    currentBranch = childrenNode;
  }

  const anchor = renderer.createComment("error-boundary");
  const fragment = renderer.createFragment();
  if (currentBranch !== null) renderer.appendChild(fragment, currentBranch);
  renderer.appendChild(fragment, anchor);

  // effect の初回 invocation は initial state を既に setup 済みなので skip。
  // dependency (error.value) の subscribe は依然として行われる (effect body 内で
  // 読むため)。reset 等 2 回目以降の signal 変化で本来の切替 logic に入る。
  let initialEffect = true;
  effect(() => {
    const err = error.value;
    if (initialEffect) {
      initialEffect = false;
      return;
    }

    // 既存 branch を DOM から外す (切替前の共通処理)
    if (currentBranch !== null) {
      currentBranch.parentNode?.removeChild(currentBranch);
      currentBranch = null;
    }

    // children() / fallback() の内部で読む signal は boundary の再実行 trigger にしたくないので untrack
    untrack(() => {
      if (err === null) {
        // children 表示。reset 後など owner が無ければ再 mount (state 初期化)。
        if (childrenOwner === null) mountChildren();
        if (childrenNode !== null) {
          anchor.parentNode?.insertBefore(childrenNode, anchor);
          currentBranch = childrenNode;
        }
        if (fallbackOwner) {
          fallbackOwner.dispose();
          fallbackOwner = null;
        }
      } else {
        // fallback 表示。children をまず dispose して子 Effect を止める。
        if (childrenOwner) {
          childrenOwner.dispose();
          childrenOwner = null;
          childrenNode = null;
        }
        if (fallbackOwner) fallbackOwner.dispose();
        fallbackOwner = new Owner(parentOwner);
        // fallback owner に handler は付けない — 内で throw したら親へ bubble up する。
        const node = fallbackOwner.runCatching(() => props.fallback(err, reset));
        if (node !== undefined) {
          anchor.parentNode?.insertBefore(node, anchor);
          currentBranch = node;
        }
      }
    });
  });

  onCleanup(() => {
    currentBranch?.parentNode?.removeChild(currentBranch);
    anchor.parentNode?.removeChild(anchor);
    if (childrenOwner) childrenOwner.dispose();
    if (fallbackOwner) fallbackOwner.dispose();
  });

  return fragment;
}
