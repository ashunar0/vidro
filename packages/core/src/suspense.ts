import { effect } from "./effect";
import { Owner, getCurrentOwner, onCleanup } from "./owner";
import { untrack } from "./observer";
import { getRenderer } from "./renderer";
import { SuspenseScope, runWithSuspenseScope } from "./suspense-scope";
import { getCurrentStream } from "./streaming-scope";

type SuspenseProps = {
  /** pending 中に表示する UI を返す関数。最初に pending が観測された時点で 1 回だけ評価する。 */
  fallback: () => Node;
  /** ErrorBoundary と同じく getter で受ける。boundary が自分の SuspenseScope を
   *  set した状態で評価する必要があるため (B-4 children getter 化と整合)。 */
  children: () => Node;
};

/**
 * Suspense 境界 primitive (ADR 0029、B-5b)。children 内で構築された
 * `createResource` が pending の間は fallback を表示し、すべて resolve したら
 * children に切替える。
 *
 * 機構:
 *   1. SuspenseScope を作成、children() を runWithSuspenseScope で wrap して評価
 *   2. children 内で `createResource(...)` が呼ばれると getCurrentSuspense() で
 *      scope を捕捉し、scope.register() で count 加算
 *   3. resolve / reject で unregister、count が 0 になったら pending=false
 *   4. effect で scope.pending を購読、変化で fallback ↔ children を DOM 切替
 *      (ErrorBoundary と同じ fragment + currentBranch + anchor 構造)
 *
 * children の Owner は dispose せず保持する (Solid 互換) — pending 中も裏で
 * 生きていて、resolve 時は同じ Node を再表示。state や effect は連続性を持つ。
 *
 * server / client 共通で renderer 経由 (ADR 0021 系列):
 *   - server: children を sync 評価してそのまま吐く。resource は loading=true の
 *     まま markup に入る (B-5b スコープ、B-5c で bootstrap cache 命中で改善)
 *   - client (mount / hydrate): SuspenseScope set 状態で children 評価、初回
 *     pending なら fallback も sync 評価して initial branch にする
 */
export function Suspense(props: SuspenseProps): Node {
  const renderer = getRenderer();

  // server mode: scope を一応 set するが、resolve は走らないので fallback には
  // 切替えず children をそのまま吐く。anchor は client / hydrate と同 shape の
  // `<!--suspense-->` を fragment 末尾に置く (ADR 0021 系列の規約)。
  if (renderer.isServer) {
    const stream = getCurrentStream();
    if (stream) {
      // streaming SSR (Phase C-2、ADR 0031): children を 1 度評価して fetcher
      // を集めるが markup は捨て、shell には fallback markup を出す。boundary
      // 範囲を `<!--vb-${id}-start--> ... <!--vb-${id}-end-->` で囲み、tail で
      // `__vidroFill` が start/end 間の node を template content と差し替える。
      // anchor `<!--suspense-->` は client mode と整合させて hydrate cursor を
      // 揃えるためそのまま末尾に置く (start/end は __vidroFill が remove する)。
      const id = stream.allocBoundaryId();
      const innerScope = new SuspenseScope();
      runWithSuspenseScope(innerScope, () => {
        props.children();
      });
      const fallbackScope = new SuspenseScope();
      const fallbackNode = runWithSuspenseScope(fallbackScope, () => props.fallback());
      stream.registerBoundary(id, props.children);
      const fragment = renderer.createFragment();
      renderer.appendChild(fragment, renderer.createComment(`vb-${id}-start`));
      renderer.appendChild(fragment, fallbackNode);
      renderer.appendChild(fragment, renderer.createComment(`vb-${id}-end`));
      renderer.appendChild(fragment, renderer.createComment("suspense"));
      return fragment;
    }
    // 既存 (renderToStringAsync 用 or streaming context 解除済み boundary-pass)
    const scope = new SuspenseScope();
    const node = runWithSuspenseScope(scope, () => props.children());
    const fragment = renderer.createFragment();
    renderer.appendChild(fragment, node);
    renderer.appendChild(fragment, renderer.createComment("suspense"));
    return fragment;
  }

  // --- client mode (mount / hydrate 共通) ---
  const scope = new SuspenseScope();
  const parentOwner = getCurrentOwner();

  // children を Owner 内で評価。runWithSuspenseScope で wrap して、内部 createResource
  // が scope を捕捉できるようにする。children Owner は dispose せず保持し、resolve
  // 時にそのまま再表示する (連続性を持つ)。
  const childrenOwner = new Owner(parentOwner);
  let childrenNode: Node | null = null;
  childrenOwner.run(() => {
    runWithSuspenseScope(scope, () => {
      childrenNode = props.children();
    });
  });

  // 初回評価後の pending 判定。pending なら fallback も sync 評価して initial branch
  // にする (server / hydrate 整合: SSR で吐いた markup と client 初回 cursor を
  // 一致させるため)。
  let fallbackOwner: Owner | null = null;
  let fallbackNode: Node | null = null;
  let currentBranch: Node | null;

  if (scope.pending) {
    fallbackOwner = new Owner(parentOwner);
    fallbackOwner.run(() => {
      fallbackNode = props.fallback();
    });
    currentBranch = fallbackNode;
  } else {
    currentBranch = childrenNode;
  }

  const anchor = renderer.createComment("suspense");
  const fragment = renderer.createFragment();
  if (currentBranch !== null) renderer.appendChild(fragment, currentBranch);
  renderer.appendChild(fragment, anchor);

  // pending signal の変化で fallback ↔ children を切替。
  // 初回 invocation は initial state を既に setup 済みなので skip し、依存登録のみ。
  let initialEffect = true;
  effect(() => {
    const pending = scope.pending;
    if (initialEffect) {
      initialEffect = false;
      return;
    }

    // 既存 branch を DOM から外す (切替前の共通処理)
    if (currentBranch !== null) {
      currentBranch.parentNode?.removeChild(currentBranch);
      currentBranch = null;
    }

    // children() / fallback() の中で読む signal は Suspense の再実行 trigger に
    // したくないので untrack
    untrack(() => {
      if (pending) {
        // children → fallback 切替: childrenOwner は dispose せず保持
        if (!fallbackOwner) {
          fallbackOwner = new Owner(parentOwner);
          fallbackOwner.run(() => {
            fallbackNode = props.fallback();
          });
        }
        if (fallbackNode !== null) {
          anchor.parentNode?.insertBefore(fallbackNode, anchor);
          currentBranch = fallbackNode;
        }
      } else {
        // fallback → children 切替: fallback dispose、保持していた childrenNode を再表示
        if (fallbackOwner) {
          fallbackOwner.dispose();
          fallbackOwner = null;
          fallbackNode = null;
        }
        if (childrenNode !== null) {
          anchor.parentNode?.insertBefore(childrenNode, anchor);
          currentBranch = childrenNode;
        }
      }
    });
  });

  onCleanup(() => {
    currentBranch?.parentNode?.removeChild(currentBranch);
    anchor.parentNode?.removeChild(anchor);
    childrenOwner.dispose();
    if (fallbackOwner) fallbackOwner.dispose();
  });

  return fragment;
}
