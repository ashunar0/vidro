import { Signal } from "./signal";
import { effect } from "./effect";
import { Owner, getCurrentOwner, onCleanup } from "./owner";
import { untrack } from "./observer";

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
 */
export function ErrorBoundary(props: ErrorBoundaryProps): Node {
  const anchor = document.createComment("error-boundary");
  const fragment = document.createDocumentFragment();
  fragment.appendChild(anchor);

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

  // 初回は effect を立てる前に評価する。children() が初期描画で throw した場合でも、
  // reportError が先に error.value を埋めるので、直後の effect 初回実行で fallback ブランチに入る。
  mountChildren();

  effect(() => {
    const err = error.value;

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
