import { effect, ErrorBoundary, getRenderer, onCleanup, readVidroData, signal } from "@vidro/core";
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
  _getSubmissionMutator,
  _registerDispatcher,
  type SubmissionError,
} from "./action";

// ADR 0038: Router 内 dispatch の mutator 引数 shape (action.ts と整合)。
// ADR 0040 (Phase 4 step 1): setInput を form 経路でも呼ぶため interface に追加。
type SubmissionMutator = {
  setResult: (r: unknown) => void;
  setError: (e: SubmissionError) => void;
  setPending: (v: boolean) => void;
  setInput: (v: Record<string, unknown> | undefined) => void;
  isPending: () => boolean;
};

// ---- bootstrap data (Phase A SSR data injection) ----
// server (createServerHandler) が navigation response の index.html に
// `<script type="application/json" id="__vidro_data">` として埋め込んだ
// 初期 loader data を module load 時に 1 回だけ取り出す。最初の render で
// consume し、以降の navigation では従来通り /__loader を fetch する。
type BootstrapLayer = { data?: unknown; error?: { name: string; message: string; stack?: string } };
type BootstrapData = { pathname: string; params: Record<string, string>; layers: BootstrapLayer[] };

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
  /** server 側で gatherRouteData した結果 (pathname / params / layers を含む) */
  bootstrapData: BootstrapData;
  /** preloadRouteComponents で事前解決した component 群 */
  resolvedModules: ResolvedModules;
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
  const onPopState = () => {
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

  // ---- form submit delegation (ADR 0038 Phase 3 R-mid-1) ----
  // method="post" の form を Web 標準のまま hijack して action 経路に流す。
  // event bubble の capture phase で拾うと nested form / event.stopPropagation
  // による取りこぼしを回避できる。
  //
  // R-mid-1 では `<form {...sub.bind()}>` の `data-vidro-sub` attribute がある
  // form だけ hijack 対象。attribute 不在の form は browser default 動作 (= 通常
  // POST navigation) に委ねる。これにより JSX 上で「Vidro が拾うか否か」が明示。
  const onSubmit = (e: SubmitEvent): void => {
    const target = e.target;
    if (!(target instanceof HTMLFormElement)) return;
    if (target.method.toLowerCase() !== "post") return;
    const subId = target.dataset.vidroSub;
    if (!subId) return; // attribute 不在 = hijack せず default 動作
    const mutator = _getSubmissionMutator(subId);
    if (!mutator) return;
    // 注意: mutator 不在は「`bind()` を spread した form があるが `submission(key)` が
    // 一度も呼ばれていない」状態。理論上は SSR で form の HTML が出てる + client が
    // hydrate 完了する前に submit イベントが firing した極小窓だけ。silently fall through
    // して browser default の full-page POST に委ねる (= server action は動くので致命傷
    // にはならない)。preventDefault しないのは意図的。
    e.preventDefault();
    void handleFormSubmit(target, mutator);
  };
  window.addEventListener("submit", onSubmit, true);
  onCleanup(() => window.removeEventListener("submit", onSubmit, true));

  // ---- dispatcher 登録 (programmatic submit 用、ADR 0038 大論点 4) ----
  // submission.submit() が呼ぶ経路。form delegation と同じ dispatchSubmit を
  // 共有して、loader 自動 revalidate / redirect / error handling のロジックを
  // 1 経路に統一する。Router unmount 時に unregister。
  const unregisterDispatcher = _registerDispatcher({
    dispatch: (path, mutator, fetchInit) =>
      dispatchSubmit(path, mutator, () =>
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

  let initialNode: Node | null = null;
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
      initialNode = foldRouteTree({
        match: initialMatch,
        componentMods: resolved.layouts.concat(resolved.route ? [resolved.route] : []),
        loaderResults,
        errorMods: resolved.errors,
        reset,
      });
    }
  }

  const anchor = r.createComment("router");
  const fragment = r.createFragment();
  if (initialNode) r.appendChild(fragment, initialNode);
  r.appendChild(fragment, anchor);

  // 前回 swap 時の DOM Node 群。次の swap で removeChild するため記録。
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

  // hydrate 経路で sync 初期化を行ったので、effect 初回は skip して 2 回目以降
  // (= navigation) のみ async load を回す。skipNext を 1 つ立てておけば、effect
  // 初回 invocation で early return。pathname / reloadCounter は依然 dependency
  // として登録されるので、後続の変化はちゃんと拾われる。
  let skipNextEffect = canSyncBootstrap && initialNode !== null;
  // route 切替時の stale resolve 対策: token が一致した resolve のみ DOM に反映。
  let loadToken = 0;

  function swap(next: Node): void {
    for (const node of currentNodes) {
      node.parentNode?.removeChild(node);
    }
    // fragment は insertBefore 時に展開されて空になるので、child Node を先に記録。
    // 単一 Node (text / element) の場合は自分自身を 1 要素配列として記録。
    const nextNodes: Node[] =
      next.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? Array.from(next.childNodes) : [next];
    (anchor as unknown as Node).parentNode?.insertBefore(next, anchor as unknown as Node);
    currentNodes = nextNodes;
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
   * form submit (ADR 0038 R-mid-1) は dispatchSubmit に流す薄い wrapper。
   * form の action 属性 || current pathname を POST 先に決め、FormData 化した
   * body を fetch に渡す。response 分岐は dispatchSubmit 共通経路で処理。
   */
  async function handleFormSubmit(
    form: HTMLFormElement,
    mutator: SubmissionMutator,
  ): Promise<void> {
    // ADR 0040 review fix #1: 連打 guard は setInput **より前** に置く。
    // ADR の lifecycle 表「連打 guard で no-op になった呼出 → input は上書き
    // されない」を form 経路でも守るため、programmatic 経路 (submit() factory)
    // と guard 位置を揃える。dispatchSubmit 冒頭の isPending guard は直接呼出
    // 防衛として残す (= 二重チェック)。
    if (mutator.isPending()) return;
    const path = form.getAttribute("action") || currentPathname.value;
    const fd = new FormData(form);
    // ADR 0040: 楽観的 preview 用 input を dispatch 前に確定。
    // FormData の重複 key (= multi-value) は last-wins で潰れる、production では
    // qs ライブラリ等で richer decoding するが toy 段階の妥協。
    mutator.setInput(Object.fromEntries(fd as unknown as Iterable<[string, FormDataEntryValue]>));
    await dispatchSubmit(path, mutator, () =>
      fetch(path, { method: "POST", body: fd, headers: { Accept: "application/json" } }),
    );
  }

  /**
   * form 経由 / programmatic submit 共通の dispatch core (ADR 0038)。
   * 連打 guard は per-instance (mutator.isPending) で行う:
   *   - 同 instance の in-flight 中は無視 (= 連打弾き)
   *   - 別 instance なら並列実行可
   *
   * response 分岐:
   *   1. redirected → navigate で新 path に遷移、pending 解除のみ
   *   2. JSON `{actionResult, loaderData}` → mutator.setResult + bootstrapData 上書き
   *      + reset() で loader 自動 revalidate (1 往復)
   *   3. JSON `{error}` → mutator.setError
   *   4. non-JSON / fetch 失敗 → NetworkError 化して mutator.setError
   *
   * `path !== currentPathname.value` の場合は bootstrapData 上書きをせず
   * navigate(path) で正規 navigation に流す (R-min review fix #3 と同じ理由)。
   */
  async function dispatchSubmit(
    path: string,
    mutator: SubmissionMutator,
    fetchFn: () => Promise<Response>,
  ): Promise<void> {
    if (mutator.isPending()) return; // 同 instance の連打 guard

    // ADR 0041: in-flight 中に別 path へ navigate されたら、_clearAllSubmissionState
    // で flush 済の registry に書き戻さない (= 古い結果が新 page に漏れる stale-write
    // 防止)。loadToken パターンと同思想で、navigation の境界を超えたら結果を捨てる。
    const originPathname = currentPathname.value;
    const stillOnOriginPath = (): boolean => currentPathname.value === originPathname;

    mutator.setPending(true);

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
        // _clearAllSubmissionState() が走るので、redirect 先で古い "Added: ..." が
        // 残ることはない (= ADR 0041 の bonus fix)。同 path への redirect だけは
        // signal が同値 set で notify されず flush しない既知の限界 (ADR 0041 残課題)。
        const target = new URL(res.url);
        navigate(target.pathname + target.search);
        return;
      }

      const ctype = res.headers.get("content-type") ?? "";
      if (!ctype.includes("application/json")) {
        mutator.setError({
          name: "NetworkError",
          message: `non-JSON response (status ${res.status})`,
        });
        return;
      }

      const body = (await res.json()) as ActionResponse;

      // body parse の await 後にもう一度 path 変化を確認 (= レアだが二重 await の安全網)
      if (!stillOnOriginPath()) return;

      if (body.error) {
        mutator.setError(body.error);
        return;
      }

      mutator.setResult(body.actionResult);

      if (body.loaderData) {
        if (path === currentPathname.value) {
          bootstrapData = {
            pathname: path,
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
      mutator.setError({
        name: "NetworkError",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      // 別 path 済なら pending は flush 済 (= false)。ここで setPending すると
      // navigate 先で同 key を再 submit 中の pending=true を上書きする可能性があるので
      // skip する。同 path に居る場合のみ pending を解除。
      if (stillOnOriginPath()) {
        mutator.setPending(false);
      }
    }
  }

  async function fetchLoaders(pathname: string): Promise<Array<{ data: unknown; error: unknown }>> {
    if (bootstrapData && bootstrapData.pathname === pathname) {
      const boot = bootstrapData;
      bootstrapData = null;
      return boot.layers.map((r) => ({
        data: r.data,
        error: r.error ? hydrateError(r.error) : undefined,
      }));
    }

    const res = await fetch(`/__loader?path=${encodeURIComponent(pathname)}`);
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

  effect(() => {
    // reload trigger を dependency に登録 (reset() で再実行されるため)。
    // `void` は「副作用として読むだけ」の意図表明 (lint の no-unused-expressions 回避)。
    void reloadCounter.value;
    const pathname = currentPathname.value;
    if (skipNextEffect) {
      skipNextEffect = false;
      return;
    }
    const match = matchRoute(pathname, compiled);
    const token = ++loadToken;

    const leafLoader = match.route ? match.route.load : compiled.notFound?.load;
    if (!leafLoader) {
      // not-found.tsx なし、かつ route match なし → 素朴にテキスト
      swap(r.createText("404 Not Found") as unknown as Node);
      return;
    }

    // 3 系列を同時起動して Promise.all:
    //   1. component modules (layouts + leaf の .tsx)
    //   2. loader 実行結果 (server の /__loader endpoint から bulk 取得)
    //   3. 全 error.tsx modules (層ごとの選び分けのため preload)
    // 並列 fetch の本体は server 側 (plugin の serverBoundary が Promise.all で
    // layer 並列実行する)。client は HTTP 1 回だけで、waterfall にならない。
    const loadComponents = Promise.all([...match.layouts.map((l) => l.load()), leafLoader()]);
    const loadLoaderResults = fetchLoaders(pathname);
    // match.errors[i] と errorMods[i] は 1:1 対応 (深い → 浅い順)。個別 load 失敗は
    // null に fall back させ、selectErrorMod が自然に次の候補に skip する。
    const loadErrorMods = Promise.all(
      match.errors.map((e) => (e.load() as Promise<ErrorModule>).catch(() => null)),
    );

    void Promise.all([loadComponents, loadLoaderResults, loadErrorMods])
      .then(([rawMods, loaderResults, errorMods]) => {
        if (token !== loadToken) return;
        // 子孫が currentParams を読めるよう、fold 前に新 route の params に同期。
        // foldRouteTree 内で評価される component の effect / JSX が新 params を
        // 見るタイミングを fold 開始前に揃える。
        currentParams.value = match.params;
        const componentMods = rawMods as RouteModule[];
        const node = foldRouteTree({
          match,
          componentMods,
          loaderResults,
          errorMods,
          reset,
        });
        swap(node);
      })
      .catch((err) => {
        // component module の load 失敗 (network failure 等)。error.tsx modules の
        // load 失敗は個別に null に吸収されてるので、ここに来るのは component module
        // load 失敗が主。loader throw は runServerLoader で吸い込み済み。
        if (token !== loadToken) return;
        console.error("[router] module load error:", err);
        swap(defaultErrorNode(err));
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

  try {
    if (!ssr.resolvedModules.route) {
      return r.createText("404 Not Found") as unknown as Node;
    }

    // loader 結果を client mode と同じ shape に整える (hydrateError で Error に復元)
    const loaderResults = ssr.bootstrapData.layers.map((l) => ({
      data: l.data,
      error: l.error ? hydrateError(l.error) : undefined,
    }));

    const node = foldRouteTree({
      match,
      componentMods: ssr.resolvedModules.layouts.concat([ssr.resolvedModules.route]),
      loaderResults,
      errorMods: ssr.resolvedModules.errors,
      reset: () => {
        // server では reset 発火不可。client hydration で再発火する前提。
      },
    });

    // client と同 shape: fragment.children = [route_node, anchor]
    const fragment = r.createFragment();
    r.appendChild(fragment, node);
    r.appendChild(fragment, r.createComment("router"));
    return fragment;
  } finally {
    currentPathname.value = previousPathname;
    currentParams.value = previousParams;
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

function foldRouteTree(input: FoldInput): Node {
  const { match, componentMods, loaderResults, errorMods, reset } = input;

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
  const wrapLayout = (
    layoutMod: RouteModule,
    layerPathPrefix: string,
    data: unknown,
    children: () => Node,
  ): Node =>
    ErrorBoundary({
      fallback: (err) => renderError(err, selectErrorMod(layerPathPrefix), match.params, reset),
      onError: (err) => console.error("[router] layout render error:", err),
      children: () => layoutMod.default({ params: match.params, data, children }),
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
    // errorIndex が layouts.length なら leaf loader error → 最寄り (null)
    // それ以外は layout[errorIndex] の pathPrefix より外側の error.tsx を使う
    const errorLayerPrefix =
      errorIndex < match.layouts.length ? match.layouts[errorIndex]!.pathPrefix : null;
    nodeFn = () => renderError(loaderError, selectErrorMod(errorLayerPrefix), match.params, reset);
    // error layer より外側の layouts で fold。外側 layouts も render error を
    // 起こしうるので wrapLayout で個別 ErrorBoundary wrap する。
    for (let i = errorIndex - 1; i >= 0; i--) {
      const inner = nodeFn;
      const layoutMod = componentMods[i]!;
      const data = loaderResults[i]!.data;
      const layerPathPrefix = match.layouts[i]!.pathPrefix;
      nodeFn = () => wrapLayout(layoutMod, layerPathPrefix, data, inner);
    }
  } else {
    // 全 loader 成功 → 通常経路。leaf は render error catch のため ErrorBoundary
    // で wrap (fallback は最寄り)、各 layout は wrapLayout で外側 error.tsx。
    const leafMod = componentMods[componentMods.length - 1]!;
    const leafData = loaderResults[loaderResults.length - 1]!.data;
    const layoutMods = componentMods.slice(0, -1);

    nodeFn = () =>
      ErrorBoundary({
        fallback: (err) => renderError(err, selectErrorMod(null), match.params, reset),
        onError: (err) => console.error("[router] render error:", err),
        children: () => leafMod.default({ params: match.params, data: leafData }),
      });
    for (let i = layoutMods.length - 1; i >= 0; i--) {
      const inner = nodeFn;
      const layoutMod = layoutMods[i]!;
      const data = loaderResults[i]!.data;
      const layerPathPrefix = match.layouts[i]!.pathPrefix;
      nodeFn = () => wrapLayout(layoutMod, layerPathPrefix, data, inner);
    }
  }
  return nodeFn();
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
