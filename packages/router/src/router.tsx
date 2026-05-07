import {
  __VidroServerOnlySection,
  effect,
  ErrorBoundary,
  getRenderer,
  h,
  onCleanup,
  readVidroData,
  signal,
} from "@vidro/core";
import {
  compileRoutes,
  matchRoute,
  type CompiledRoutes,
  type MatchResult,
  type RouteRecord,
} from "./route-tree";
import { currentParams, currentPathname, navigate } from "./navigation";
import {
  _clearAllSubmissionState,
  _cleanupSuccessfulSubmissions,
  _createSubmissionInstance,
  _registerDispatcher,
  normalizeSubmitInput,
  type SubmissionError,
  type SubmissionState,
} from "./action";
// ADR 0049 — loaderData() primitive 関連の internal API。
// foldRouteTree が layer の component を呼ぶ直前に layer index を立て、
// effect (revalidate) では同 pathname なら diff merge で page remount を抑止する。
import {
  _diffMergeAllLayers,
  _resetAllForServer,
  _resetPageLoaderData,
  _restoreLayerIndex,
  _setLayerIndex,
} from "./loader-data";
// ADR 0052 — searchParams() primitive 関連の internal API。
// SSR で per-request initial search を立て、popstate / navigation で signals を
// URL から書き戻す。client mode では revalidate() を Router の reset 経路に紐付ける。
import {
  _endServerSearchScope,
  _initServerSearch,
  _registerRevalidator,
  _syncSearchParamsFromUrl,
} from "./search-params";
import { hydrateIslandsInRange } from "./island";

// ADR 0051: dispatcher が受ける引数 shape は action.ts の SubmissionState を流用。
// router.tsx の dispatchSubmit / handleFormSubmit はこの interface 経由で
// pending / value / error / input を制御する。

// ---- bootstrap data (Phase A SSR data injection) ----
// server (createServerHandler) が navigation response の index.html に
// `<script type="application/json" id="__vidro_data">` として埋め込んだ
// 初期 loader data を module load 時に 1 回だけ取り出す。最初の render で
// consume し、以降の navigation では従来通り /__loader を fetch する。
type BootstrapLayer = { data?: unknown; error?: { name: string; message: string; stack?: string } };
// ADR 0052: SSR 経路で URL の search 部分 (= "?q=Vidro" 含む or "") を per-request
// で渡す。client 側は window.location.search が SoT なので bootstrap には載せない
// (= 古い navigation で生成された bootstrap が新 URL と乖離するリスクを避ける)。
type BootstrapData = {
  pathname: string;
  search?: string;
  params: Record<string, string>;
  layers: BootstrapLayer[];
};

let bootstrapData: BootstrapData | null = readBootstrapData();

function readBootstrapData(): BootstrapData | null {
  // ADR 0030 3b-α: `__vidro_data` は core の readVidroData() で 1 回だけ parse +
  // remove + cache される shared util 経由で読む。Resource 側 (resources field)
  // と読み出し順序の心配なし。
  const data = readVidroData();
  if (!data) return null;
  const params = data.params as Record<string, string> | undefined;
  const layers = data.layers as BootstrapLayer[] | undefined;
  if (!params || !layers) return null;
  const pathname = typeof window !== "undefined" ? window.location.pathname : "";
  return { pathname, params, layers };
}

// ---- SSR (Phase B) 用型 ----
// server で Router を renderToString するとき、dynamic import は sync 化できないので
// 呼び側 (createServerHandler 等) が `preloadRouteComponents` で事前に全 module を
// 解決し、`resolvedModules` として Router に注入する。Router はこれを受けたら
// effect を張らず、sync に fold して Node tree を返す。
//
// bootstrapData は Phase A と同形式。server 側で gatherRouteData した結果を
// そのまま渡せる。
type RouteModule = { default: (props: Record<string, unknown>) => Node };
type ErrorModule = {
  default: (props: { error: unknown; reset: () => void; params: Record<string, string> }) => Node;
};

export type ResolvedModules = {
  /** leaf route の module。not-found 時は null */
  route: RouteModule | null;
  /** 浅い → 深い順の layout modules (match.layouts と同じ順序) */
  layouts: RouteModule[];
  /** 深い → 浅い順の error.tsx modules (match.errors と同じ順序)。個別 null は許容 */
  errors: Array<ErrorModule | null>;
};

export type SSRProps = {
  /** server 側で gatherRouteData した結果 (pathname / params / layers を含む)。
   *  partial render の場合 layers は **divergeIndex 以降の layer + leaf** だけを含む。 */
  bootstrapData: BootstrapData;
  /** preloadRouteComponents で事前解決した component 群。
   *  partial render の場合 layouts は **divergeIndex 以降の slice**。 */
  resolvedModules: ResolvedModules;
  /** ADR 0061: partial HTML render mode。`startIdx` は共通 prefix の長さ (= 共通 layout 数)。
   *  指定されると foldRouteTree に startIdx を渡して layer N 以降だけ render し、anchor
   *  Comment を fragment に含めない (= partial fragment は client の既存 layer N の DOM
   *  range にそのまま挿入される)。 */
  partial?: { startIdx: number };
};

type RouterProps = {
  routes: RouteRecord;
  /** server-side pre-render mode。渡されると Router は sync fold して Node を返す。 */
  ssr?: SSRProps;
  /** hydrate 経路用 (B-3b)。`import.meta.glob(..., { eager: true })` の結果を渡すと、
   *  client mode の **初回** render を sync fold して既存 markup を消費する。
   *  以降の navigation は従来通り async load + swap。 */
  eagerModules?: Record<string, unknown>;
};

/**
 * app 全体のルーティングを司る component。`routes` は `import.meta.glob` の結果を
 * そのまま渡す形式 (index.tsx / layout.tsx / server.ts / layout.server.ts /
 * error.tsx / not-found.tsx)。
 *
 * client mode (default): pathname の変化を subscribe し、マッチした route + 親 layout
 * 群 + 各 layer の loader + pathname に match する全 error.tsx を lazy load。各 load
 * は Promise.all で並列実行 (Remix 式 data fetching、設計書 3.7)。
 *
 * client mode + hydrate (`eagerModules` あり): 初回 render は bootstrap data +
 * 事前解決済 modules を使って **sync fold**。HydrationRenderer の cursor を
 * SSR markup と整合させて消費する。effect / popstate は従来通り張られるが、
 * 初回は skip される (2 回目以降の navigation 専用)。
 *
 * server mode (`ssr` prop あり): 呼び側が preloadRouteComponents で解決済み modules を
 * 注入するので effect を張らず、sync fold で Node tree を返す。renderToString から
 * 呼ぶのが前提で、navigation も popstate subscribe も発生しない (ADR 0017)。
 *
 * render は fold 構造: leaf + 各 layout を個別に `ErrorBoundary` で wrap しながら
 * 深い → 浅い順に `{ data, children: prev }` で畳む。layer ごとの ErrorBoundary
 * fallback は「その layer より外側の error.tsx」で切り替わる。
 */
export function Router(props: RouterProps): Node {
  const compiled = compileRoutes(props.routes);

  // server mode: sync fold → 直接 fragment を返す。DOM / window 系に触らない。
  if (props.ssr) {
    return renderServerSide(compiled, props.ssr);
  }

  // --- client mode ---
  const r = getRenderer();

  // popstate (戻る/進む) で pathname signal を同期。Router が mount されてる間だけ
  // listener を張り、dispose で剥がす。
  //
  // ADR 0052: searchParams() で取得済の signals も URL の search 部分と同期させる
  // ため、_syncSearchParamsFromUrl() を pathname 更新の前に呼ぶ。これで pathname
  // 変化を trigger に effect が再 fire する時点で signals は既に新値を持つ。
  const onPopState = () => {
    _syncSearchParamsFromUrl();
    currentPathname.value = window.location.pathname;
  };
  window.addEventListener("popstate", onPopState);
  onCleanup(() => window.removeEventListener("popstate", onPopState));

  // reset() で effect を再実行するための trigger。currentPathname の同値 set だと
  // signal が notify しないので、別軸で reload trigger を持つ。
  const reloadCounter = signal(0);
  const reset = (): void => {
    reloadCounter.value += 1;
  };

  // ADR 0052 revalidate(): user が `await revalidate()` で loader 再 fire 完了を待つ
  // 経路。effect の Promise.all 解決 (or reject) 時に flushPendingRevalidations() で
  // 全 resolver を発火する。複数 revalidate() が短時間に呼ばれると同じ次の effect で
  // まとめて resolve される (= 同 pathname で deduplicate しない、一律「次の解決」を
  // 待つだけのシンプル仕様)。
  let pendingRevalidations: Array<() => void> = [];
  const flushPendingRevalidations = (): void => {
    const resolvers = pendingRevalidations;
    pendingRevalidations = [];
    for (const r of resolvers) r();
  };
  const unregisterRevalidator = _registerRevalidator(
    () =>
      new Promise<void>((resolve) => {
        pendingRevalidations.push(resolve);
        reset();
      }),
  );
  onCleanup(() => {
    unregisterRevalidator();
    // mount 中に await されてた pending を全部解決して await 側 を leak させない。
    flushPendingRevalidations();
  });

  // ---- form submit delegation (ADR 0051) ----
  // method="post" の form を Web 標準のまま hijack して action 経路に流す。
  // event bubble の capture phase で拾うと nested form / event.stopPropagation
  // による取りこぼしを回避できる。
  //
  // ADR 0051 で `data-vidro-sub` attribute による opt-in は廃止し、route page 上の
  // **全 method="post" form を自動 intercept** に倒した。1 route = 1 action 規約 +
  // intent pattern が canonical なので、form ごとの opt-in marker は不要。
  // 例外的に hijack させたくない form は `data-vidro-no-intercept` を付ける
  // (= 通常 POST navigation に流す escape hatch、痛みが出てから運用判断)。
  const onSubmit = (e: SubmitEvent): void => {
    const target = e.target;
    if (!(target instanceof HTMLFormElement)) return;
    if (target.method.toLowerCase() !== "post") return;
    if (target.dataset.vidroNoIntercept !== undefined) return;
    e.preventDefault();
    // ADR 0051: submitter (= 押された <button>) を FormData constructor に渡すことで
    // `<button name="intent" value="...">` の name/value を FormData に含める。
    // 1 引数の `new FormData(form)` は submit button の name/value を含めない HTML
    // 仕様 (= input/select/textarea のみ列挙)、submitter を渡して intent pattern を成立させる。
    void handleFormSubmit(target, e.submitter as HTMLElement | null);
  };
  window.addEventListener("submit", onSubmit, true);
  onCleanup(() => window.removeEventListener("submit", onSubmit, true));

  // ---- link click delegation (ADR 0062) ----
  // ADR 0060 で `.server.tsx` は client bundle 上で stub 化されるため、その内側に
  // 書かれた `<Link>` は client で render されず onClick が attach されない。結果
  // として leaf 内 Link は browser default の full reload に倒れて ADR 0061 の
  // partial swap 経路に乗らない。document level で `<a>` クリックを一括 intercept
  // することで、leaf / layout どちらに居る Link でも均等に SPA 経路に流す。
  //
  // `<Link>` 内の onClick は ADR 0062 で削除済 (= aria-current 糖衣だけに縮退)。
  // 生 `<a href="/foo">` も同経路で SPA 化される (= Hono 的透明性、設計書 5 哲学)。
  const onLinkClick = (e: MouseEvent): void => {
    if (e.defaultPrevented) return;
    if (e.button !== 0) return;
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    const target = e.target;
    if (!(target instanceof Element)) return;
    const a = target.closest("a[href]");
    if (!(a instanceof HTMLAnchorElement)) return;
    // target="_blank" / "_top" / 名前付き frame は browser に任せる ("_self" のみ intercept)
    if (a.target !== "" && a.target !== "_self") return;
    if (a.hasAttribute("download")) return;
    // 異 origin / `mailto:` / `tel:` / `javascript:` 等は HTMLAnchorElement.origin が
    // 現 origin と一致しないので origin check 1 本で除外可能
    if (a.origin !== window.location.origin) return;
    e.preventDefault();
    navigate(a.pathname + a.search + a.hash);
  };
  window.addEventListener("click", onLinkClick);
  onCleanup(() => window.removeEventListener("click", onLinkClick));

  // ---- dispatcher 登録 (programmatic submit 用、ADR 0051) ----
  // 公開 `submit()` (top-level) と Submission.retry() が呼ぶ経路。form delegation と
  // 同じ dispatchSubmit を共有して、loader 自動 revalidate / redirect / error handling
  // のロジックを 1 経路に統一する。Router unmount 時に unregister。
  const unregisterDispatcher = _registerDispatcher({
    dispatch: (path, state, fetchInit) =>
      dispatchSubmit(path, state, () =>
        fetch(path, {
          method: "POST",
          body: fetchInit.body,
          headers: { ...fetchInit.headers, Accept: "application/json" },
        }),
      ),
  });
  onCleanup(unregisterDispatcher);

  // ---- navigation 単位 submission state flush (ADR 0041) ----
  // currentPathname が変わった瞬間に registry の全 entry の field を空に戻す。
  // - 初回 invocation (= mount 直後 / hydrate) は skip。「ページに来た瞬間に
  //   既存の submission を消す」のは意図しない (= 例えば form post 直後の SSR で
  //   bootstrapData 経由で result を表示するケース)
  // - 同 path への navigate (signal 同値 set) は notify されないので skip
  // - reloadCounter 経由の loader revalidate は別 signal なので dep に入らず skip
  //   = "Added: ..." 等の result が同 path 内で消えない (= ADR 0038 維持)
  // - 別 path navigate / popstate / submit redirect → flush
  let skipFirstClear = true;
  effect(() => {
    void currentPathname.value;
    if (skipFirstClear) {
      skipFirstClear = false;
      return;
    }
    _clearAllSubmissionState();
  });

  // ---- 初回 render (sync fold or fallback empty fragment) ----
  // hydrate 経路: eagerModules + bootstrapData が両方あれば、server と同じ
  // foldRouteTree を sync で呼んで初回 markup を消費する。HydrationRenderer
  // の cursor は post-order 消費なので、(node, anchor) の順で作る。
  //
  // 通常 mount 経路: 初回 render は空 fragment を返し、effect 内の async load
  // で初めて DOM を組む (従来挙動)。
  const initialMatch = matchRoute(currentPathname.value, compiled);
  const canSyncBootstrap =
    !!props.eagerModules && !!bootstrapData && bootstrapData.pathname === currentPathname.value;

  // ADR 0049: 「最後の成功 render」を記録して、effect の next run が同 pathname
  // への revalidate なら page remount せず diff merge に切り替える。pathname /
  // layer 数が違う or error 発生 → 通常 swap (page remount)。
  let lastSuccessRender: { pathname: string; layerCount: number } | null = null;

  let initialNode: Node | null = null;
  let initialLayerRanges: Map<number, LayerRange> | null = null;
  if (canSyncBootstrap) {
    const eager = props.eagerModules!;
    const boot = bootstrapData!;
    const resolved = resolveModulesSync(initialMatch, eager, compiled);
    if (resolved) {
      // bootstrap data を消費 (mount 経路と同じ「1 回だけ使う」セマンティクス)
      bootstrapData = null;
      // hydrate sync 初期化: 子孫が currentParams を読めるよう先に同期。server で
      // 解決済みの boot.params を使う (initialMatch.params と同じだが、SSR と
      // markup 整合のため server 経路と同じ値を採用)。
      currentParams.value = boot.params;
      const loaderResults = boot.layers.map((l) => ({
        data: l.data,
        error: l.error ? hydrateError(l.error) : undefined,
      }));
      // ADR 0049: foldRouteTree の前に layer-indexed raw を確定。user の
      // route component が sync に loaderData() を呼んだ時、現 layer の raw を
      // 引き当てて store として返せるようにする。
      _resetPageLoaderData(loaderResults.map((r) => r.data));
      const folded = foldRouteTree({
        match: initialMatch,
        componentMods: resolved.layouts.concat(resolved.route ? [resolved.route] : []),
        loaderResults,
        errorMods: resolved.errors,
        reset,
      });
      initialNode = folded.node;
      initialLayerRanges = folded.layerRanges;
      // 成功 render を記録: 後続 effect が「同 pathname への revalidate」を判定する。
      const hasError = loaderResults.some((r) => r.error !== undefined);
      if (!hasError) {
        lastSuccessRender = { pathname: boot.pathname, layerCount: loaderResults.length };
      }
    }
  }

  const anchor = r.createComment("router");
  const fragment = r.createFragment();
  if (initialNode) r.appendChild(fragment, initialNode);
  r.appendChild(fragment, anchor);

  // 前回 swap 時の DOM Node 群。next swap (full) で removeChild するため記録。
  //
  // hydrate 経路 (anchor.parentNode が non-null = 既に target 内に居る) では
  // HydrationRenderer の appendChild が「target 内の既存 Node を fragment に
  // 動かさない」設計 (ADR 0021)。そのため initialNode (fragment) は anchor
  // しか含まず、SSR markup は target 直下の anchor 直前に並んでいる。
  // anchor の previousSibling を辿って currentNodes を再構築する。
  //
  // mount 経路 (anchor.parentNode が null) では従来通り、initialNode の
  // childNodes (fragment は後で外側に append される際に空になるので、先に
  // 取り出しておく) または initialNode 単体を currentNodes とする。
  let currentNodes: Node[] = [];
  if (anchor.parentNode) {
    let n = (anchor as Node).previousSibling;
    while (n) {
      currentNodes.unshift(n);
      n = n.previousSibling;
    }
  } else if (initialNode) {
    currentNodes =
      initialNode.nodeType === Node.DOCUMENT_FRAGMENT_NODE
        ? Array.from(initialNode.childNodes)
        : [initialNode];
  }

  // ADR 0061 Phase 2: 各 layer の DOM range marker (= `<!--vl-N-start-->` /
  // `<!--vl-N-end-->`) への参照を絶対 layerIdx でキー付け。partial swap (= layer N
  // の range だけ入れ替え) の identity として使う。
  //
  // - hydrate 経路: HydrationRenderer.createComment が SSR Comment への live ref
  //   を返すので、initialLayerRanges の Comment は DOM 上の SSR Comment 参照。
  // - mount 経路: foldRouteTree が新規作成した Comment が後ほど anchor 前に
  //   insertBefore で DOM 連結される (= effect 経路の swap 経由)。Task #3 で対応。
  let currentLayerRanges: Map<number, LayerRange> = initialLayerRanges ?? new Map();

  // hydrate 経路で sync 初期化を行ったので、effect 初回は skip して 2 回目以降
  // (= navigation) のみ async load を回す。skipNext を 1 つ立てておけば、effect
  // 初回 invocation で early return。pathname / reloadCounter は依然 dependency
  // として登録されるので、後続の変化はちゃんと拾われる。
  let skipNextEffect = canSyncBootstrap && initialNode !== null;
  // route 切替時の stale resolve 対策: token が一致した resolve のみ DOM に反映。
  let loadToken = 0;

  /**
   * full swap: 旧 currentNodes 全部を removeChild → 新 fragment を anchor 前に insert。
   * page 切替 (= layout 数違い / loader error / 別 path) で使う経路。
   * `nextLayerRanges` を渡せば currentLayerRanges を全置換。partial fragment と
   * 区別するため optional (= 省略時は currentLayerRanges を空に reset)。
   */
  function swap(next: Node, nextLayerRanges?: Map<number, LayerRange>): void {
    for (const node of currentNodes) {
      node.parentNode?.removeChild(node);
    }
    // fragment は insertBefore 時に展開されて空になるので、child Node を先に記録。
    // 単一 Node (text / element) の場合は自分自身を 1 要素配列として記録。
    const nextNodes: Node[] =
      next.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? Array.from(next.childNodes) : [next];
    (anchor as unknown as Node).parentNode?.insertBefore(next, anchor as unknown as Node);
    currentNodes = nextNodes;
    currentLayerRanges = nextLayerRanges ?? new Map();
  }

  /**
   * ADR 0061 Phase 2: partial swap。指定 layer N の `<!--vl-N-start-->` から
   * `<!--vl-N-end-->` までの range (両端含む) を削除し、partial fragment を旧 start
   * の位置に insertBefore で挿入する。共通 prefix layer (= 0..layerIdx-1) はそのまま
   * DOM に残るので flash なし、layout 据置で島 hydrate も維持される。
   *
   * - `partial`: server `/__partial` から fetch + parse した partial fragment。
   *    内部に `<!--vl-${layerIdx}-start-->` 〜 `<!--vl-${leafLayerIdx}-end-->` の
   *    range marker を持つ前提。
   * - `partialLayerRanges`: 新 partial fragment 内の各 layer (絶対 index) → range
   *    の Map。partial fragment が DOM に挿入された後、Comment 参照は live。
   */
  function swapLayer(
    layerIdx: number,
    partial: Node,
    partialLayerRanges: Map<number, LayerRange>,
  ): void {
    const oldRange = currentLayerRanges.get(layerIdx);
    if (!oldRange || !oldRange.start.parentNode) {
      // range が見つからない / DOM 上に無い (= 想定外) → 安全側に倒して full reload。
      // 上位 (navigate) で fetch reject 同等の F-α 経路を踏ませる。
      throw new Error(`[router] swapLayer: layer ${layerIdx} range not found`);
    }
    const parent = oldRange.start.parentNode;
    // start と end が同 parent でないと range が壊れている (= 別経路の DOM 操作で end が
    // 外された等)。anchor までの誤削除事故を防ぐため early throw して F-α 経路に倒す。
    if (oldRange.end.parentNode !== parent) {
      throw new Error(`[router] swapLayer: layer ${layerIdx} end detached from start parent`);
    }
    // 旧 range 内の sibling を start から end まで集めて remove。end に到達せず sibling
    // が尽きた場合 (= end が外れていた等) は anchor まで巻き込む事故になるので throw。
    const toRemove: Node[] = [];
    let n: Node | null = oldRange.start;
    let reachedEnd = false;
    while (n) {
      toRemove.push(n);
      if (n === oldRange.end) {
        reachedEnd = true;
        break;
      }
      n = n.nextSibling;
    }
    if (!reachedEnd) {
      throw new Error(`[router] swapLayer: layer ${layerIdx} end not found by sibling walk`);
    }
    parent.insertBefore(partial, oldRange.start);
    for (const node of toRemove) {
      node.parentNode?.removeChild(node);
    }
    // currentLayerRanges を更新: 共通 prefix (= 0..layerIdx-1) はそのまま、
    // layerIdx 以降を partialLayerRanges で置換。
    for (const idx of Array.from(currentLayerRanges.keys())) {
      if (idx >= layerIdx) currentLayerRanges.delete(idx);
    }
    for (const [idx, r] of partialLayerRanges) {
      currentLayerRanges.set(idx, r);
    }
    // currentNodes は anchor 直前を逆走査して再構築 (= 共通 prefix Comment + 新 partial
    // の Node 全部を集める)。partial swap は full swap と違って共通 prefix が DOM 上に
    // 残るため、走査で集まる Node 群が「次回 full swap で removeChild すべき対象」。
    if (anchor.parentNode) {
      const collected: Node[] = [];
      let p = (anchor as Node).previousSibling;
      while (p) {
        collected.unshift(p);
        p = p.previousSibling;
      }
      currentNodes = collected;
    }
  }

  /**
   * ADR 0061 Phase 2: `.server.tsx` leaf への navigation を `/__partial` 経由で
   * 実行する経路。client bundle に leaf component module が居ない (= ADR 0060 stub)
   * ため、server で render 済の HTML fragment を取得して `swapLayer` で DOM 注入する。
   *
   * - F-α (= ADR 0061): fetch reject / 4xx / 5xx / parse 失敗 → `window.location.assign`
   *   で full reload。partial swap は state を信用できる時だけ実行する。
   * - C-α (= ADR 0061): swap 後に `hydrateIslandsInRange` で partial fragment 範囲内の
   *   island marker を walk して hydrate (Task #5 で実装)。
   * - loadToken: effect 経由で発行された token と一致しない場合 (= 別 navigation が
   *   後発で割り込んだ) は処理捨て (既存 async load 経路と同 race 対策)。
   */
  async function runPartialNavigation(
    token: number,
    fromUrl: string,
    toUrl: string,
    match: MatchResult,
  ): Promise<void> {
    const url = `/__partial?to=${encodeURIComponent(toUrl)}&from=${encodeURIComponent(fromUrl)}`;
    let res: Response;
    try {
      res = await fetch(url);
    } catch (err) {
      if (token !== loadToken) return;
      console.error("[router] partial fetch failed:", err);
      window.location.assign(toUrl);
      return;
    }
    if (token !== loadToken) return;
    if (!res.ok) {
      console.error(`[router] partial fetch returned ${res.status}`);
      window.location.assign(toUrl);
      return;
    }
    const divergeHeader = res.headers.get("x-vidro-diverge-index") ?? "";
    const divergeIndex = Number.parseInt(divergeHeader, 10);
    const html = await res.text();
    if (token !== loadToken) return;
    if (Number.isNaN(divergeIndex) || divergeIndex < 0) {
      console.error(`[router] invalid x-vidro-diverge-index: ${divergeHeader}`);
      window.location.assign(toUrl);
      return;
    }

    // partial HTML を <template> で parse → DocumentFragment。template content は
    // inert tree なので内部 <script> は実行されない (= push hook 経由の hydrate に
    // 依存しない設計、ADR 0061 D-2 reviewer M-3 と整合)。
    const tpl = document.createElement("template");
    tpl.innerHTML = html;
    const partialFragment = tpl.content;
    const partialLayerRanges = collectLayerRanges(partialFragment);

    try {
      swapLayer(divergeIndex, partialFragment, partialLayerRanges);
    } catch (err) {
      console.error("[router] partial swap failed:", err);
      window.location.assign(toUrl);
      return;
    }

    // 共通 prefix layer の effect / Link 等が新 params を読めるよう同期。
    currentParams.value = match.params;

    // ADR 0061 C-α: swap 後に partial 範囲内の island marker を walk して hydrate。
    // 新 layer N の range marker (= partialLayerRanges.get(divergeIndex)) を起点に。
    const newRange = currentLayerRanges.get(divergeIndex);
    if (newRange) {
      hydrateIslandsInRange(newRange.start, newRange.end);
    }

    // 通常経路の diff merge 判定 (= 同 pathname revalidate) は client fold 用なので、
    // partial 経路後は lastSuccessRender を null にして state machine を分離する。
    // 次に通常経路 page (= 通常 .tsx) に navigate した時は full remount で動く。
    lastSuccessRender = null;
    flushPendingRevalidations();
  }

  // `/__loader?path=...` を叩いて全 layer の loader 結果を 1 回の HTTP で取得する
  // (Remix 式 RPC)。server 側 (@vidro/plugin の serverBoundary) が layer 並列実行を
  // 肩代わりするので、ここでの Promise.all は 1 系列だけで済む。
  // response shape: `{ params, layers: [{ data? , error? SerializedError }, ...] }`。
  // error は serialize された plain object で来るため、Error-like に hydrate し直して
  // 既存の err.message / err.stack 依存コードを動かす。
  //
  // Phase A bootstrap: 初回 navigation だけ、server が index.html に inline した
  // `__vidro_data` を使って fetch を skip する。pathname 一致を確認したうえで
  // consume し、以降は HTTP 経路に戻る。
  /**
   * form submit (ADR 0051) は dispatchSubmit に流す薄い wrapper。
   * form の action 属性 || current pathname を POST 先に決め、FormData 化した body を
   * 新 Submission instance に紐づけて発射する。response 分岐は dispatchSubmit 共通経路。
   *
   * 連打 guard は per-instance では行わない (= 各 submit が新 instance で複数 in-flight
   * 自然対応)。連打を抑止したい場合は user 側で `<button disabled={pending}>` 等に倒す。
   */
  async function handleFormSubmit(
    form: HTMLFormElement,
    submitter: HTMLElement | null,
  ): Promise<void> {
    // ADR 0053: action attribute が無ければ現在の URL (= pathname + search) を使う。
    // submit 後の loader 自動 revalidate で server-side loader が search を読めるよう、
    // search を含めた URL に POST する (= action handleAction で revalidateRequest が
    // この URL を継ぐ)。user が `<form action="/other">` を明示してれば user 意図を尊重。
    const search = typeof window !== "undefined" ? window.location.search : "";
    const path = form.getAttribute("action") || currentPathname.value + search;
    // FormData(form, submitter) で submit button の name/value も乗せる (= intent pattern)。
    const fd = new FormData(form, submitter);
    const input = normalizeSubmitInput(fd);
    // 新 Submission instance を route slot に push (= UI 側の `submissions().value` で即見える)。
    const { state } = _createSubmissionInstance(path, input, fd, {});
    await dispatchSubmit(path, state, () =>
      fetch(path, { method: "POST", body: fd, headers: { Accept: "application/json" } }),
    );
  }

  /**
   * form 経由 / programmatic submit 共通の dispatch core (ADR 0051)。
   *
   * ADR 0038 までの per-key 連打 guard は ADR 0051 で廃止 (= 各 submit が新 instance、
   * 並列 in-flight が canonical)。dispatchSubmit は 1 instance の lifecycle を進める
   * だけのシンプルな関数。
   *
   * response 分岐:
   *   1. redirected → navigate で新 path に遷移、pending 解除のみ
   *   2. JSON `{actionResult, loaderData}` → state.setResult + bootstrapData 上書き
   *      + reset() で loader 自動 revalidate (1 往復)
   *   3. JSON `{error}` → state.setError
   *   4. non-JSON / fetch 失敗 → NetworkError 化して state.setError
   *
   * `path !== currentPathname.value` の場合は bootstrapData 上書きをせず
   * navigate(path) で正規 navigation に流す。
   */
  async function dispatchSubmit(
    path: string,
    state: SubmissionState,
    fetchFn: () => Promise<Response>,
  ): Promise<void> {
    // ADR 0041: in-flight 中に別 path へ navigate されたら、_clearAllSubmissionState
    // で flush 済の registry に書き戻さない (= 古い結果が新 page に漏れる stale-write
    // 防止)。loadToken パターンと同思想で、navigation の境界を超えたら結果を捨てる。
    const originPathname = currentPathname.value;
    const stillOnOriginPath = (): boolean => currentPathname.value === originPathname;

    type ActionResponse = {
      actionResult?: unknown;
      loaderData?: { params: Record<string, string>; layers: BootstrapLayer[] };
      error?: SubmissionError;
    };

    try {
      const res = await fetchFn();

      // 別 path へ navigate 済 → 結果を捨てる。pending=false 化は flush が肩代わり済。
      if (!stillOnOriginPath()) return;

      if (res.redirected) {
        // server-side `Response.redirect(...)` は default redirect=follow で追従済み。
        // navigate() で client navigation に流すと、その currentPathname 変化で
        // _clearAllSubmissionState() が走るので、redirect 先で古い submission が
        // 残ることはない (= ADR 0041 の bonus fix)。同 path への redirect だけは
        // signal が同値 set で notify されず flush しない既知の限界 (ADR 0041 残課題)。
        const target = new URL(res.url);
        navigate(target.pathname + target.search);
        return;
      }

      const ctype = res.headers.get("content-type") ?? "";

      // ADR 0059: 4xx + JSON + body has `fields` → validation error 扱い、
      // sub.fieldError に流す。それ以外の 4xx (= 401/403 等で fields 無し) や
      // JSON parse 失敗は system error path に fall through。
      if (res.status >= 400 && res.status < 500 && ctype.includes("application/json")) {
        try {
          const validationBody = (await res.clone().json()) as { fields?: unknown };
          if (
            validationBody &&
            typeof validationBody === "object" &&
            "fields" in validationBody &&
            validationBody.fields &&
            typeof validationBody.fields === "object"
          ) {
            // body parse の await 後にもう一度 path 変化を確認 (= 二重 await の安全網)
            if (!stillOnOriginPath()) return;
            state.setFieldError(validationBody.fields as Record<string, string>);
            return;
          }
        } catch {
          // JSON parse 失敗 → system error path に fall through
        }
      }

      if (!ctype.includes("application/json")) {
        state.setError({
          name: "NetworkError",
          message: `non-JSON response (status ${res.status})`,
        });
        return;
      }

      const body = (await res.json()) as ActionResponse;

      // body parse の await 後にもう一度 path 変化を確認 (= レアだが二重 await の安全網)
      if (!stillOnOriginPath()) return;

      if (body.error) {
        state.setError(body.error);
        return;
      }

      state.setResult(body.actionResult);

      if (body.loaderData) {
        // ADR 0053: path に search 込み (= "/notes?q=Vidro&page=2") を許容するため、
        // 同 page 判定は **pathname のみ** で行う。bootstrapData.pathname も search 抜き
        // で保つ (fetchLoaders の bootstrap 比較と整合)。
        const targetPathname = (() => {
          try {
            return new URL(path, window.location.origin).pathname;
          } catch {
            return path;
          }
        })();
        if (targetPathname === currentPathname.value) {
          bootstrapData = {
            pathname: currentPathname.value,
            params: body.loaderData.params,
            layers: body.loaderData.layers,
          };
          reset();
        } else {
          navigate(path);
        }
      }
    } catch (err) {
      // navigate 後に reject (= AbortError 等) しても registry に書き戻さない。
      if (!stillOnOriginPath()) return;
      state.setError({
        name: "NetworkError",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      // 別 path 済なら pending は flush 済 (= false)。ここで setPending すると
      // navigate 先で submission を再生成中の pending=true を上書きする可能性があるので
      // skip する。同 path に居る場合のみ pending を解除。
      if (stillOnOriginPath()) {
        state.setPending(false);
      }
    }
  }

  // ADR 0053: server-side loader が URL の search 部分 (= `?page=` / `?q=` 等) を
  // 読めるようにするため、`/__loader?path=...` で送る path に **`pathname + search`**
  // を入れる。bootstrap 比較は pathname のみ (= server inject 時に search 含めない
  // 設計と整合、初回 hydrate は経路 1 = handleNavigation で search を server に
  // 渡し済 → bootstrap data は search 抜きで pathname だけ判定して OK)。
  async function fetchLoaders(
    pathname: string,
    search: string,
  ): Promise<Array<{ data: unknown; error: unknown }>> {
    if (bootstrapData && bootstrapData.pathname === pathname) {
      const boot = bootstrapData;
      bootstrapData = null;
      return boot.layers.map((r) => ({
        data: r.data,
        error: r.error ? hydrateError(r.error) : undefined,
      }));
    }

    const path = pathname + search;
    const res = await fetch(`/__loader?path=${encodeURIComponent(path)}`);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      // endpoint 自体が 4xx/5xx → 復旧できないので outer catch (default error) へ
      throw hydrateError(body.error ?? { message: `HTTP ${res.status}` });
    }
    const body = (await res.json()) as {
      params: Record<string, string>;
      layers: Array<{ data?: unknown; error?: { name: string; message: string; stack?: string } }>;
    };
    return body.layers.map((r) => ({
      data: r.data,
      error: r.error ? hydrateError(r.error) : undefined,
    }));
  }

  // ADR 0061 Phase 2: partial fetch (= /__partial) で送る `from` の seal 用。effect 開始時に
  // 「from = prevPathname + prevSearch、to = pathname + search」を計算して partial URL を組む。
  // navigate() / popstate 直後の effect 内で window.location は **新 URL** に同期済 (= browser
  // が pushState / popstate より前に URL を反映)、よって prev は別途 closure で記録する必要がある。
  let prevPathname = currentPathname.value;
  let prevSearch = typeof window !== "undefined" ? window.location.search : "";

  effect(() => {
    // reload trigger を dependency に登録 (reset() で再実行されるため)。
    // `void` は「副作用として読むだけ」の意図表明 (lint の no-unused-expressions 回避)。
    void reloadCounter.value;
    const pathname = currentPathname.value;
    const search = typeof window !== "undefined" ? window.location.search : "";
    if (skipNextEffect) {
      skipNextEffect = false;
      prevPathname = pathname;
      prevSearch = search;
      return;
    }
    // ADR 0061 G-α: partial 経路の `from` / `to` 用 URL を effect 開始時に seal。
    // 失敗時の full reload は to URL に行うため、prev 更新は経路成功と独立に
    // ここでまとめて行う (= reload で effect 自体が消える前提)。
    const fromUrl = prevPathname + prevSearch;
    const toUrl = pathname + search;
    prevPathname = pathname;
    prevSearch = search;

    const match = matchRoute(pathname, compiled);
    const token = ++loadToken;

    const leafLoader = match.route ? match.route.load : compiled.notFound?.load;
    if (!leafLoader) {
      // not-found.tsx なし、かつ route match なし → 素朴にテキスト
      swap(r.createText("404 Not Found") as unknown as Node);
      return;
    }

    // ADR 0061 Phase 2: leaf が `.server.tsx` の場合は client bundle 上で stub 化されて
    // いる (= ADR 0060 Phase 2)。client fold すると stub default が空を返して真っ白
    // 問題が起きる → /__partial 経由で server 側 render 済 HTML を取得して swap する。
    //
    // 同 URL (= reloadCounter 経由 revalidate / fromUrl === toUrl) でも partial fetch
    // を走らせる: `.server.tsx` page で `revalidate()` が呼ばれた意図 = server で
    // render し直して新 state を取り込む、と素直に解釈する。divergeIndex は leaf only
    // で server から返り、leaf range だけが swap される (= island state は再 hydrate)。
    const isServerOnlyTarget = match.route?.filePath.endsWith(".server.tsx") === true;
    if (isServerOnlyTarget) {
      void runPartialNavigation(token, fromUrl, toUrl, match);
      return;
    }

    // 3 系列を同時起動して Promise.all:
    //   1. component modules (layouts + leaf の .tsx)
    //   2. loader 実行結果 (server の /__loader endpoint から bulk 取得)
    //   3. 全 error.tsx modules (層ごとの選び分けのため preload)
    // 並列 fetch の本体は server 側 (plugin の serverBoundary が Promise.all で
    // layer 並列実行する)。client は HTTP 1 回だけで、waterfall にならない。
    const loadComponents = Promise.all([...match.layouts.map((l) => l.load()), leafLoader()]);
    // ADR 0053: revalidate() / `<Link>` で同 page 内 navigate 時に server-side loader
    // が `?page=` / `?q=` 等を読めるよう、現 URL の search を path に乗せて送る。
    // (search は effect 上部で seal 済の値を再利用)
    const loadLoaderResults = fetchLoaders(pathname, search);
    // match.errors[i] と errorMods[i] は 1:1 対応 (深い → 浅い順)。個別 load 失敗は
    // null に fall back させ、selectErrorMod が自然に次の候補に skip する。
    const loadErrorMods = Promise.all(
      match.errors.map((e) => (e.load() as Promise<ErrorModule>).catch(() => null)),
    );

    void Promise.all([loadComponents, loadLoaderResults, loadErrorMods])
      .then(([rawMods, loaderResults, errorMods]) => {
        if (token !== loadToken) return;
        const hasError = loaderResults.some((r) => r.error !== undefined);

        // ADR 0049: 同 pathname + 全 loader 成功 + layer 数一致 → 「page-internal
        // revalidate」とみなして diff merge で済ませる。page は remount せず、
        // page-local signal (filter / count / accordion / focus / scroll) も
        // ErrorBoundary subtree も生き続ける。
        // それ以外 (= 別 pathname / loader error / 層数違い等) は従来通り swap で
        // 全 remount。判定が誤ると user の page-local state が消えるので、より
        // 「remount 寄り」に倒した保守的判定にしている。
        const isSamePageRevalidate =
          lastSuccessRender !== null &&
          lastSuccessRender.pathname === pathname &&
          lastSuccessRender.layerCount === loaderResults.length &&
          !hasError;

        if (isSamePageRevalidate) {
          // 既存 store instance に diff merge。loaderData() を持つ全 component が
          // fine-grained に再評価され、page DOM は in-place で更新される。
          _diffMergeAllLayers(loaderResults.map((r) => r.data));
          // ADR 0051: 同 page revalidate 完了で success 状態の submission を array
          // から auto-remove する (= 楽観行が server 戻りで自動消滅、derive 派の核体験)。
          // errored submission は残留 (= retry / clear で操作)。
          _cleanupSuccessfulSubmissions(pathname);
          // ADR 0052: 同 page revalidate ブランチでも `await revalidate()` の awaiter
          // を解決する。これを忘れると同 path 内で revalidate() を await した user
          // コードが永遠に止まる (= reviewer 指摘 Issue 2)。
          flushPendingRevalidations();
          // pathname / params 同値、currentParams は前回 set 済のまま継続でよい。
          return;
        }

        // 子孫が currentParams を読めるよう、fold 前に新 route の params に同期。
        // foldRouteTree 内で評価される component の effect / JSX が新 params を
        // 見るタイミングを fold 開始前に揃える。
        currentParams.value = match.params;
        // ADR 0049: 別 page への navigation → 旧 stores は捨てて、新 raws を登録。
        // foldRouteTree で各 layer の loaderData() が新しい raw を wrap する。
        _resetPageLoaderData(loaderResults.map((r) => r.data));
        const componentMods = rawMods as RouteModule[];
        const folded = foldRouteTree({
          match,
          componentMods,
          loaderResults,
          errorMods,
          reset,
        });
        swap(folded.node, folded.layerRanges);

        // 次回 effect で revalidate 判定するための state 更新。loader error が
        // 起きていたら "成功 render" 扱いしない (= 次に成功した瞬間に diff merge
        // ではなく remount を発火させて user 状態を綺麗に流す)。
        if (hasError) {
          lastSuccessRender = null;
        } else {
          lastSuccessRender = { pathname, layerCount: loaderResults.length };
        }
        // ADR 0052: revalidate() の awaiter (= `await revalidate()`) を解決。
        flushPendingRevalidations();
      })
      .catch((err) => {
        // component module の load 失敗 (network failure 等)。error.tsx modules の
        // load 失敗は個別に null に吸収されてるので、ここに来るのは component module
        // load 失敗が主。loader throw は runServerLoader で吸い込み済み。
        if (token !== loadToken) return;
        console.error("[router] module load error:", err);
        swap(defaultErrorNode(err));
        lastSuccessRender = null;
        // ADR 0052: 失敗ケースでも awaiter は解決させる (= leak 防止)。失敗の
        // signal は user 側で別途 (例えば error.tsx の reset()) 取り扱う。
        flushPendingRevalidations();
      });
  });

  onCleanup(() => {
    for (const node of currentNodes) {
      node.parentNode?.removeChild(node);
    }
    currentNodes = [];
    (anchor as unknown as Node).parentNode?.removeChild(anchor as unknown as Node);
  });

  return fragment;
}

// ---- server-mode entry (ADR 0017 / 0020) ----
// `preloadRouteComponents` + `gatherRouteData` で事前解決した材料を使って、
// client mode と同じ foldRouteTree で sync に tree を組む。effect / popstate /
// fetch / DocumentFragment-as-mount-target は使わないが、**anchor (Comment) は
// client mode と同 shape で吐く** (ADR 0020)。client が hydrate 経由で
// 同じ cursor 順で消費できるようにするため。
//
// leaf module は `ssr.resolvedModules.route` に pre-load 済み (matched route or
// not-found.tsx どちらか)。null の場合は「route 無し & not-found.tsx も無し」と
// 解釈して client mode と同じ 404 text を返す (anchor 無し)。
function renderServerSide(compiled: CompiledRoutes, ssr: SSRProps): Node {
  const r = getRenderer();
  const match = matchRoute(ssr.bootstrapData.pathname, compiled);

  // Link 等が currentPathname を読んで active state を判定するため、SSR 中だけ
  // request pathname に切替える。server には window がないため signal の初期値は
  // "/" のままで、Link が誤判定する (Home が常に active 等)。finally で元に戻す
  // のは Workers 並行 request 間の global state 干渉を最小化するため (toy 段階の
  // 妥協、production 化時に context/AsyncLocalStorage 経由に書き換え予定 —
  // project_pending_rewrites に記録)。
  const previousPathname = currentPathname.value;
  const previousParams = currentParams.value;
  currentPathname.value = ssr.bootstrapData.pathname;
  currentParams.value = match.params;

  // ADR 0052: SSR 経路で URL の search 部分を per-request scope として立てる。
  // `searchParams()` の lazy access が server 側でも window なしで request URL の
  // 値を返せる (= `/notes?q=Vidro` 直打ちで pre-filtered HTML が出る)。SSR 終了で
  // _endServerSearchScope() が finally で flush する。bootstrapData.search が
  // undefined なら空文字 (= search なし) で初期化。
  _initServerSearch(ssr.bootstrapData.search ?? "");

  try {
    if (!ssr.resolvedModules.route) {
      return r.createText("404 Not Found") as unknown as Node;
    }

    // loader 結果を client mode と同じ shape に整える (hydrateError で Error に復元)
    const loaderResults = ssr.bootstrapData.layers.map((l) => ({
      data: l.data,
      error: l.error ? hydrateError(l.error) : undefined,
    }));

    // ADR 0049: server render でも foldRouteTree 前に layer-indexed raw を確定。
    // user の sync `loaderData()` が server 側でも raw を引き当てて store として
    // 動く (= SSR で `<For each={data.notes}>` が成立する)。
    //
    // ADR 0061 partial mode: loaderResults は partial slice (= divergeIndex 以降)
    // だが loaderData() lookup は **絶対 layerIdx** で行うため、divergeIndex 個分の
    // undefined を先頭に padding して raws を absolute index 化する。共通 prefix
    // layer の loaderData() は呼ばれない前提 (= partial fragment 内に共通 layout
    // component は居ない)。
    const startIdx = ssr.partial?.startIdx ?? 0;
    const paddedRaws =
      startIdx > 0
        ? [...Array.from<unknown>({ length: startIdx }), ...loaderResults.map((r) => r.data)]
        : loaderResults.map((r) => r.data);
    _resetPageLoaderData(paddedRaws);

    const { node } = foldRouteTree(
      {
        match,
        componentMods: ssr.resolvedModules.layouts.concat([ssr.resolvedModules.route]),
        loaderResults,
        errorMods: ssr.resolvedModules.errors,
        reset: () => {
          // server では reset 発火不可。client hydration で再発火する前提。
        },
      },
      { startIdx },
    );

    // ADR 0061 partial mode: fragment ではなく Node 単体を返す (= anchor 無し)。
    // partial fragment は client の既存 layer N の DOM range にそのまま挿入される
    // 設計なので、router anchor の Comment は不要。
    if (ssr.partial) {
      return node;
    }

    // full mode: client と同 shape (= fragment.children = [route_node, anchor])
    const fragment = r.createFragment();
    r.appendChild(fragment, node);
    r.appendChild(fragment, r.createComment("router"));
    return fragment;
  } finally {
    currentPathname.value = previousPathname;
    currentParams.value = previousParams;
    // ADR 0049: server render 終了で module scope を空に戻す。Workers の同 isolate
    // 内で並行 request が走った時、こちらの request の loaderRaws が混入しない
    // ように最低限の safety net (= AsyncLocalStorage 化は project_pending_rewrites)。
    _resetAllForServer();
    // ADR 0052: searchParams 用の per-request scope も同タイミングで flush。
    _endServerSearchScope();
  }
}

// ---- fold logic (client / server 共通) ----
// 解決済みの (match, componentMods, loaderResults, errorMods) を受け取って、
// layer error 検査 + ErrorBoundary wrap + layout fold を行い Node を返す pure 関数。
type FoldInput = {
  match: MatchResult;
  componentMods: RouteModule[];
  loaderResults: Array<{ data: unknown; error: unknown }>;
  errorMods: Array<ErrorModule | null>;
  reset: () => void;
};

/**
 * ADR 0061 Phase 2: 各 layer の出力を `<!--vl-${layerIdx}-start-->` /
 * `<!--vl-${layerIdx}-end-->` で囲む。partial swap 時に「layer N の DOM range
 * だけ入れ替え」を成立させるため、SSR HTML / client mount / hydrate のどの
 * 経路でも同じ marker が出る。Map は closure local で hidden global を回避
 * (= Open Q2: 案 a)。
 */
type LayerRange = { start: Comment; end: Comment };
type FoldOutput = {
  node: Node;
  /** 絶対 layerIdx (= startIdx + partial-relative i) → range marker の Map。
   *  fold 後に呼び出し元が pull して `currentLayerRanges` に格納する。 */
  layerRanges: Map<number, LayerRange>;
};

/**
 * ADR 0061: partial render 経路では `componentMods` / `loaderResults` を
 * **partial slice** (= startIdx 以降の layer + leaf だけ) で受け取る。fold loop の
 * partial-relative `i` から絶対 layerIdx を出すため `startIdx` を加算する。既存呼び出し
 * 元 (renderServerSide / hydrate sync / async effect) は startIdx 省略で従来動作。
 *
 * 設計判定: 案 a (拡張引数) を採用 (= 案 b の専用関数分離より変更最小)。
 * 内部 loop の startIdx 加算は薄い差し込みで済むため。
 *
 * Phase 2 で戻り値を `{ node, layerRanges }` に変更 (= Open Q2 案 a)。各 layer の
 * 出力を fragment 内で `<!--vl-N-start-->` / `<!--vl-N-end-->` の Comment marker で
 * 囲み、Map に登録する。partial swap 時の DOM range 特定はこの Map を pull する。
 */
function foldRouteTree(input: FoldInput, options?: { startIdx?: number }): FoldOutput {
  const startIdx = options?.startIdx ?? 0;
  const { match, componentMods, loaderResults, errorMods, reset } = input;
  const renderer = getRenderer();
  const layerRanges = new Map<number, LayerRange>();

  // 各 layer の出力 Node を `<!--vl-N-start-->` / `<!--vl-N-end-->` で囲んで
  // fragment にまとめる。SSR / client mount / hydrate どの経路でも renderer 経由
  // で createComment / createFragment を呼ぶので marker 文字列 + 出現順が一致し、
  // hydrate cursor が SSR markup と整合する。
  //
  // content は **thunk で受け取る** (= eager evaluation 防止)。引数 eager 評価だと
  // content の renderer 操作が start Comment より先に走って cursor 順が壊れる。
  // 順序保証: createComment(start) → contentFn() (= 内部で更に renderer 操作) →
  // createComment(end) で SSR と client hydrate で同じ post-order を踏む。
  const wrapInRange = (layerIdx: number, contentFn: () => Node): Node => {
    const start = renderer.createComment(`vl-${layerIdx}-start`) as unknown as Comment;
    const content = contentFn();
    const end = renderer.createComment(`vl-${layerIdx}-end`) as unknown as Comment;
    layerRanges.set(layerIdx, { start, end });
    const frag = renderer.createFragment();
    renderer.appendChild(frag, start as unknown as Node);
    renderer.appendChild(frag, content);
    renderer.appendChild(frag, end as unknown as Node);
    return frag as unknown as Node;
  };

  // layer の pathPrefix (null = leaf) に応じて使う error.tsx を選ぶ。
  //   leaf → 最寄り (match.errors[0])
  //   layout[i] → pathPrefix < layerPathPrefix を満たす最深 (= errors の中で
  //              最初に該当するもの。match.errors が深い → 浅い順なので OK)
  const selectErrorMod = (layerPathPrefix: string | null): ErrorModule | null => {
    if (layerPathPrefix === null) return errorMods[0] ?? null;
    for (let i = 0; i < match.errors.length; i++) {
      if (match.errors[i]!.pathPrefix.length < layerPathPrefix.length) {
        return errorMods[i] ?? null;
      }
    }
    return null;
  };

  // layout を ErrorBoundary で wrap し、render error 時にその layer より外側の
  // error.tsx で置き換える。children は **`() => Node` の getter** で受け取り
  // (ADR 0026、B-4-b)、layoutMod.default に getter のまま渡す。user の layout
  // 側で `<main>{children}</main>` の `{children}` は _$dynamicChild の 0-arg
  // function auto-invoke で展開される。これで JSX 評価順が SSR の post-order
  // (depth-first) と一致するようになり、hydrate cursor mismatch が解消される。
  //
  // ADR 0049: layer index を component default 呼び出し前に setLayerIndex で立てる。
  // user の layout / page 内 sync な loaderData() 呼び出しが現 layer の raw を引き
  // 当てられる。ErrorBoundary の children getter 側で try/finally する (= boundary
  // の fallback 経路は layer index に依存しないので影響なし)。
  const wrapLayout = (
    layoutMod: RouteModule,
    layerPathPrefix: string,
    data: unknown,
    children: () => Node,
    layerIdx: number,
  ): Node =>
    ErrorBoundary({
      fallback: (err) => renderError(err, selectErrorMod(layerPathPrefix), match.params, reset),
      onError: (err) => console.error("[router] layout render error:", err),
      children: () => {
        const prev = _setLayerIndex(layerIdx);
        try {
          return layoutMod.default({ params: match.params, data, children });
        } finally {
          _restoreLayerIndex(prev);
        }
      },
    });

  // loader error を layer 単位で検査。最も外側 (最小 index) を採用し、その
  // layer 以降 (内側 layouts + leaf) を切り捨てる。
  let errorIndex = -1;
  let loaderError: unknown;
  for (let i = 0; i < loaderResults.length; i++) {
    if (loaderResults[i]!.error !== undefined) {
      errorIndex = i;
      loaderError = loaderResults[i]!.error;
      break;
    }
  }

  // 内側の layer から順に thunk を組み立てる。最外側 thunk を呼ぶと、ErrorBoundary
  // の mountChildren → layoutMod.default → JSX 評価 → `{children}` で内側 thunk
  // を auto-invoke という連鎖で depth-first に DOM を構築する (ADR 0026)。
  let nodeFn: () => Node;
  if (errorIndex !== -1) {
    // partial-relative errorIndex を絶対 index に変換して error.tsx 選定する。
    // absErrorIdx が match.layouts.length なら leaf loader error → 最寄り (null)
    const absErrorIdx = startIdx + errorIndex;
    const errorLayerPrefix =
      absErrorIdx < match.layouts.length ? match.layouts[absErrorIdx]!.pathPrefix : null;
    // error 表示 layer も range marker で囲む (= partial swap で error layer ごと
    // 入れ替え可能にする)。range key は絶対 layerIdx。
    nodeFn = () =>
      wrapInRange(absErrorIdx, () =>
        renderError(loaderError, selectErrorMod(errorLayerPrefix), match.params, reset),
      );
    // error layer より外側の (partial slice 内の) layouts で fold。外側 layouts も
    // render error を起こしうるので wrapLayout で個別 ErrorBoundary wrap する。
    for (let i = errorIndex - 1; i >= 0; i--) {
      const inner = nodeFn;
      const layoutMod = componentMods[i]!;
      const data = loaderResults[i]!.data;
      const absLayerIdx = startIdx + i;
      const layerPathPrefix = match.layouts[absLayerIdx]!.pathPrefix;
      nodeFn = () =>
        wrapInRange(absLayerIdx, () =>
          wrapLayout(layoutMod, layerPathPrefix, data, inner, absLayerIdx),
        );
    }
  } else {
    // 全 loader 成功 → 通常経路。leaf は render error catch のため ErrorBoundary
    // で wrap (fallback は最寄り)、各 layout は wrapLayout で外側 error.tsx。
    const leafMod = componentMods[componentMods.length - 1]!;
    const layoutMods = componentMods.slice(0, -1);
    // ADR 0049: leaf の layer index は (絶対) layouts.length 番目 = startIdx + 内部 index。
    // partial slice の場合、内部 layout 数 = layoutMods.length、絶対 leaf index は startIdx + layoutMods.length。
    const leafLayerIdx = startIdx + layoutMods.length;

    // ADR 0060 partial hydration: leaf route の filePath が `.server.tsx` で終わる場合、
    // page output 全体を `__VidroServerOnlySection` で囲む。これで server は
    // `<!--vs-1-start-->...<!--vs-1-end-->` で page を囲んだ HTML を出し、client shell
    // hydrate cursor は span を skip する。内部の島 marker は別経路 (= setupIslandHydration)
    // で hydrate される。
    const isServerOnlyLeaf = match.route?.filePath.endsWith(".server.tsx") === true;

    const invokeLeaf = (): Node => {
      // ADR 0049 step 6: PageProps から data field を削除した。runtime でも
      // leaf に data prop は渡さず、user は loaderData<typeof loader>() で
      // reactive に取得する。layouts は LayoutProps が依然 data 持ちなので
      // wrapLayout 側は維持。
      //
      // ADR 0066 dogfood (Phase 5): leaf の direct call (= `leafMod.default(...)`) から
      // `h(leafMod.default, props)` 経由に切り替える。これで leaf が async function
      // (= `.server.tsx` 内 `async function PostsIndex() { const x = await ...; ... }`) の
      // 場合に core h() の Promise 判定経路が走り、AsyncScope.registerPending +
      // VAsyncSlot 生成で markup に焼かれる。sync leaf は h() の sync component path で
      // 既存通り評価されるので動作変化なし。
      const prev = _setLayerIndex(leafLayerIdx);
      try {
        return h(leafMod.default as never, { params: match.params });
      } finally {
        _restoreLayerIndex(prev);
      }
    };

    nodeFn = () =>
      wrapInRange(leafLayerIdx, () =>
        ErrorBoundary({
          fallback: (err) => renderError(err, selectErrorMod(null), match.params, reset),
          onError: (err) => console.error("[router] render error:", err),
          children: () => {
            if (isServerOnlyLeaf) {
              // children は thunk で渡す: server pass で実体評価、client (shell hydrate) では
              // 呼ばずに skip する設計を __VidroServerOnlySection が引き受ける。
              return __VidroServerOnlySection({ children: invokeLeaf }) as Node;
            }
            return invokeLeaf();
          },
        }),
      );
    for (let i = layoutMods.length - 1; i >= 0; i--) {
      const inner = nodeFn;
      const layoutMod = layoutMods[i]!;
      const data = loaderResults[i]!.data;
      const absLayerIdx = startIdx + i;
      const layerPathPrefix = match.layouts[absLayerIdx]!.pathPrefix;
      nodeFn = () =>
        wrapInRange(absLayerIdx, () =>
          wrapLayout(layoutMod, layerPathPrefix, data, inner, absLayerIdx),
        );
    }
  }
  return { node: nodeFn(), layerRanges };
}

// ---- error helpers (renderer 経由) ----

function defaultErrorNode(err: unknown): Node {
  const r = getRenderer();
  const div = r.createElement("div");
  const text = r.createText(`Error: ${err instanceof Error ? err.message : String(err)}`);
  r.appendChild(div, text);
  return div as unknown as Node;
}

function renderError(
  err: unknown,
  errorMod: ErrorModule | null,
  params: Record<string, string>,
  reset: () => void,
): Node {
  if (errorMod) return errorMod.default({ error: err, reset, params });
  return defaultErrorNode(err);
}

// plain object → Error。server 側から JSON で来た `{ name, message, stack }` を
// Error インスタンスに復元することで、既存 ErrorBoundary / renderError の
// `err.message` / `err instanceof Error` 依存を満たす。
function hydrateError(raw: unknown): Error {
  if (raw && typeof raw === "object" && "message" in raw) {
    const obj = raw as { name?: string; message?: string; stack?: string };
    const err = new Error(obj.message ?? "Unknown error");
    if (obj.name) err.name = obj.name;
    if (obj.stack) err.stack = obj.stack;
    return err;
  }
  return new Error(String(raw));
}

// ---- eager modules → ResolvedModules (B-3b 暫定) ----
// hydrate 経路で sync 初期化するために、`import.meta.glob({ eager: true })` の
// 結果から match に必要な modules を sync で取り出す。
// - leaf: matched route があればその filePath、無ければ not-found.tsx
// - layouts / errors: それぞれの filePath で lookup
// 何か 1 つでも lookup に失敗したら null を返し、Router 側は async load 経路に
// fallback する (= 普通の mount と同じ初回挙動)。
function resolveModulesSync(
  match: MatchResult,
  eager: Record<string, unknown>,
  compiled: CompiledRoutes,
): ResolvedModules | null {
  let routeMod: RouteModule | null = null;
  if (match.route) {
    const m = eager[match.route.filePath];
    if (!m) return null;
    routeMod = m as RouteModule;
  } else if (compiled.notFound) {
    const m = eager[compiled.notFound.filePath];
    if (!m) return null;
    routeMod = m as RouteModule;
  }

  const layouts: RouteModule[] = [];
  for (const l of match.layouts) {
    const m = eager[l.filePath];
    if (!m) return null;
    layouts.push(m as RouteModule);
  }

  const errors: Array<ErrorModule | null> = [];
  for (const e of match.errors) {
    const m = eager[e.filePath];
    // error.tsx は個別 null 許容 (foldRouteTree が next 候補に skip する)
    errors.push(m ? (m as ErrorModule) : null);
  }

  return { route: routeMod, layouts, errors };
}

/**
 * ADR 0061 Phase 2: partial fragment 内の `<!--vl-N-start-->` / `<!--vl-N-end-->`
 * Comment marker を walk して、絶対 layerIdx → range の Map を構築する。
 *
 * 前提: server `renderPartialHTML` (server.ts) が divergeIndex 以降の各 layer に対して
 * `wrapInRange` で start/end Comment を出している (= foldRouteTree が同 marker shape
 * で SSR markup を生成する)。
 *
 * 不正な markup (= 同 layerIdx 重複 / start/end mismatch / 空 fragment) は warning して
 * 部分的な map を返す (= 上位の swapLayer で range 不在として throw → full reload 経路)。
 */
function collectLayerRanges(
  fragment: DocumentFragment | Element,
): Map<number, { start: Comment; end: Comment }> {
  const map = new Map<number, { start: Comment; end: Comment }>();
  if (typeof document === "undefined") return map;
  const iter = document.createNodeIterator(fragment, NodeFilter.SHOW_COMMENT);
  const starts = new Map<number, Comment>();
  let n: Node | null;
  while ((n = iter.nextNode())) {
    const c = n as Comment;
    const v = c.nodeValue ?? "";
    const startMatch = /^vl-(\d+)-start$/.exec(v);
    if (startMatch) {
      starts.set(Number.parseInt(startMatch[1]!, 10), c);
      continue;
    }
    const endMatch = /^vl-(\d+)-end$/.exec(v);
    if (endMatch) {
      const idx = Number.parseInt(endMatch[1]!, 10);
      const start = starts.get(idx);
      if (start) {
        map.set(idx, { start, end: c });
        starts.delete(idx);
      }
    }
  }
  return map;
}
