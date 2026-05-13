// @vidro/hibana/client-navigation — Step 5 (HTML swap navigation) の client runtime。
//
// ADR 0080 Phase 2-5 実装:
//   - <Link> click intercept + partial wire fetch (Phase 2)
//   - server header + partial response (Phase 3)
//   - 現 Frame stack を request header で送って共通祖先計算 (Phase 4)
//   - popstate (back/forward) 対応 + scroll restoration (Phase 5)
//
// ADR 0082 Phase 2-3 実装 (= Step 5 follow-up):
//   - <Form> submit intercept + partial wire fetch
//   - redirect follow + response.redirected 判定で URL 制御
//     (= 成功 path は pushState、失敗 path は URL 据え置き = F2 解消)
//
// 制約 (= 後続で解消):
//   - islands re-hydrate なし (= Counter state リセット、後で server inline script 統合時に対応)
//   - prefetch / View Transitions API は v2 持ち越し
//
// Wire 仕様 (= ADR 0080 §Wire spec、ADR 0082 で form 経路も同 wire を再利用):
//   request:  GET / POST <url>  Accept: text/html;hibana-partial
//                               X-Hibana-Current-Layouts: AppLayout,PostsLayout
//   response: HTTP/1.1 200 OK (or 303 + follow で 200 着地)
//             X-Hibana-Layouts:          AppLayout,AboutLayout
//             X-Hibana-Title:            <new title>
//             X-Hibana-Common-Ancestor:  <commonLen>
//             Content-Type:              text/html
//             <共通祖先以下の layouts + page を nested で render した HTML>
//
// 設計判断: ADR 0080 §機構 #3 (client navigation runtime) + ADR 0082 §機構 #2-3 (form submit)。
// 関連 memory: [[project_hibana_step5_design]], [[project_hibana_crud_dogfood_findings]]

const LINK_SELECTOR = "a[data-hibana-link]";
const FORM_SELECTOR = "form[data-hibana-form]";
const FRAME_SELECTOR = "hibana-frame[data-hibana-frame]";

// scroll 位置を URL ごとに sessionStorage で persist する key。
// session 終わったら消えるので localStorage より自然 (= 業界 default、ブラウザの scrollRestoration の代替)。
const SCROLL_KEY = (url: string): string => `hibana:scroll:${url}`;

// 並行 navigation race 対策 (= ADR 0080 review C-1): 進行中の fetch を AbortController で
// 追跡し、新 Link click が来たら前の fetch を abort する。これがないと古い response の swap が
// 新 navigation の DOM を上書きする可能性がある (= 前 fetch が response.text() await 中の race)。
let currentController: AbortController | null = null;

/**
 * Step 5 navigation runtime の setup。app の client bundle entry (= virtual:hibana/client-entry)
 * から 1 回呼ぶ。冪等: 2 度目以降の setup は no-op。
 *
 * Phase 5 で追加:
 *   - history.scrollRestoration = "manual" (= browser default の scroll 復元と競合しないように、
 *     sessionStorage 経由で自前管理する)
 *   - popstate listener (= 戻る / 進む で navigateTo を再実行、scroll 位置復元)
 *
 * 失敗時 (= Frame 不在 / fetch エラー / 5xx) は full reload に fallback
 * (= graceful degradation、user 哲学整合)。
 */
export function setupNavigation(): void {
  if (typeof window === "undefined") return;

  const w = window as Window & { __hibanaNavigationSetup?: true };
  if (w.__hibanaNavigationSetup) return;
  w.__hibanaNavigationSetup = true;

  // browser default の scroll 復元と競合しないよう、manual に切り替え。
  // popstate 時に sessionStorage から自前復元する想定 (= Phase 5)。
  if ("scrollRestoration" in window.history) {
    window.history.scrollRestoration = "manual";
  }

  document.addEventListener("click", handleClick);
  document.addEventListener("submit", handleSubmit);
  window.addEventListener("popstate", handlePopState);
}

async function handleClick(event: MouseEvent): Promise<void> {
  // 修飾キー (Cmd/Ctrl/Shift/Alt) + 中クリック + 右クリックは browser default (= 別タブ等)
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  if (event.button !== 0) return;

  const target = event.target;
  if (!(target instanceof Element)) return;
  const link = target.closest(LINK_SELECTOR);
  if (!(link instanceof HTMLAnchorElement)) return;

  // target="_blank" 等の特殊遷移 / download / 外部 origin は browser default
  if (link.target && link.target !== "_self") return;
  if (link.hasAttribute("download")) return;
  if (link.origin !== window.location.origin) return;

  event.preventDefault();
  await navigateTo(link.href, { pushState: true, restoreScroll: false });
}

/**
 * popstate (= back / forward) 時のハンドラ。
 * browser が既に history を進めて URL を更新済なので、pushState は呼ばない。
 * scroll 位置は sessionStorage から復元する (= browser default が `manual` のため必須)。
 */
async function handlePopState(): Promise<void> {
  await navigateTo(window.location.href, { pushState: false, restoreScroll: true });
}

/**
 * ADR 0082: `<Form data-hibana-form>` submit を intercept、fetch + partial swap に変換する。
 *
 * 判定:
 *   - target が `<form data-hibana-form>` でなければ browser default (= 素の form submit、MPA 動作)
 *   - action が外部 origin なら browser default (= 外部送信は意図通り full submit)
 *
 * submitter (= submit を発火した button) の `formAction` / `formMethod` override は v1 では
 * 無視する (= dogfood で必要になったら対応)。typical な `<button type="submit">` 1 個の
 * single-action form は問題なく動く。
 */
async function handleSubmit(event: SubmitEvent): Promise<void> {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  if (!form.matches(FORM_SELECTOR)) return;

  // form.action は browser が absolute URL に解決済 (= 相対 URL も current origin で解決される)。
  // submitter (= e.g. <button formaction="...">) の override は v1 では無視。
  const action = new URL(form.action, window.location.origin);
  if (action.origin !== window.location.origin) return;

  event.preventDefault();
  await submitForm(form, action.href);
}

/**
 * form の submit を fetch に変換、partial response を Frame swap、URL を制御する。
 *
 * ADR 0082 §機構 #2-3:
 *   1. AbortController で並行 submit/navigate race 回避 (= ADR 0080 と共通 controller)
 *   2. fetch(action, {method, body: FormData, headers: {Accept, X-Hibana-Current-Layouts}, redirect: "follow"})
 *      - server が 303 redirect 返すと fetch が自動 follow し response.url = 最終 GET 先 URL になる
 *      - same-origin の redirect follow では Accept header が引き継がれる (= fetch spec)、
 *        最終的に server は partial response を返す
 *   3. response.redirected で success/failure 分岐:
 *      - true  = redirect follow 経由で着地 (= server c.redirect で成功扱い) → pushState + scroll top
 *      - false = 同 URL に 200 で着地 (= validation 失敗で c.render(同 page, {errors})) → URL/scroll 据え置き
 *
 * 失敗時 (= 5xx / Frame 不在 / network failure) は `window.location.href = action` で full reload
 * fallback (= ADR 0080 navigate と同 pattern)。POST 経路でも GET に倒れるが、user 再操作前提で
 * 副作用を残さない方が安全。重複 submit を避けるため form.submit() 直叩きは選ばない。
 */
async function submitForm(form: HTMLFormElement, action: string): Promise<void> {
  // navigate と同じ controller を再利用 (= submit 中の navigate / navigate 中の submit、
  // どちらも後発が勝つ業界 default pattern)。
  currentController?.abort();
  const controller = new AbortController();
  currentController = controller;

  // SSR で form の native `method` 属性は POST に倒している (= ADR 0082 Trade-off)。
  // 実 method は `data-hibana-method` attr に POST/PUT/DELETE/PATCH のいずれかが入る。
  // 万一 attr が無い (= 素の <form data-hibana-form> 等の手書きケース) は POST に fallback。
  const method = form.dataset.hibanaMethod ?? "POST";
  const body = new FormData(form);

  // 現 DOM の Frame stack を読んで request header で server に渡す (= ADR 0080 Phase 4 と同じ契約)。
  const currentFrames = Array.from(document.querySelectorAll(FRAME_SELECTOR));
  const currentLayouts = currentFrames
    .map((f) => f.getAttribute("data-layout") ?? "")
    .filter(Boolean);

  try {
    const response = await fetch(action, {
      method,
      body,
      headers: {
        Accept: "text/html;hibana-partial",
        "X-Hibana-Current-Layouts": encodeURIComponent(currentLayouts.join(",")),
      },
      credentials: "same-origin",
      // redirect: "follow" は fetch default だが意図を明示。
      // 303 (= c.redirect の default、Hono の Response.redirect) を automatic follow し、
      // 最終 GET 先で partial response を取得する。
      redirect: "follow",
      signal: controller.signal,
    });

    if (!response.ok) {
      // 4xx/5xx → full reload fallback (= action URL に GET で行く)。
      // POST の form 中身は失われるが、URL / page state は復元される。重複 submit リスク回避のため
      // form.submit() ではなく window.location 経由で GET に倒す。
      window.location.href = action;
      return;
    }

    const ok = await swapPartial(response, currentFrames);
    if (!ok) {
      // Frame 不在 / commonLen 不整合 → full reload fallback
      window.location.href = action;
      return;
    }

    if (response.redirected) {
      // 成功 path (= server が c.redirect → fetch follow → response.url = 最終 GET 先):
      //   - pushState で URL bar を最終 GET 先 (= /posts/4) に更新
      //   - 新 page に来た時は先頭から見るのが業界 default、scroll top
      window.history.pushState(null, "", response.url);
      window.scrollTo(0, 0);
    }
    // 失敗 path (= 200 + 同 URL に validation errors 込み再 render):
    //   - URL bar 据え置き (= F2 解消、reload で再 POST 警告なし)
    //   - scroll 据え置き (= 同 form の error 表示なので current scroll を保持する方が UX 良い)
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return;
    console.error("[hibana] form submit failed, falling back to full reload:", err);
    window.location.href = action;
  }
}

/**
 * URL に対応する partial response を fetch、共通祖先以下を swap する共通ルーチン。
 * click navigation と popstate (back/forward) 両方が呼ぶ。
 *
 * options.pushState:
 *   true  = 通常 navigation (= click): history.pushState で URL を進める + 現 URL の scroll 保存
 *   false = popstate: browser が既に history を動かしてるので pushState 不要、scroll 保存も不要
 *
 * options.restoreScroll:
 *   true  = popstate: sessionStorage から scroll 位置復元
 *   false = click: top に scroll (= 新 page に来た時は先頭から見る、業界 default)
 */
async function navigateTo(
  url: string,
  options: { pushState: boolean; restoreScroll: boolean },
): Promise<void> {
  // click 時、現 URL の scroll 位置を保存。後で popstate で戻ってきた時に復元するため。
  if (options.pushState) {
    sessionStorage.setItem(SCROLL_KEY(window.location.href), String(window.scrollY));
  }

  // 前の navigation が in-flight なら abort (= ADR 0080 review C-1)。
  // 古い response の swap が新 DOM を上書きしないよう、後発が前を abort する方針。
  currentController?.abort();
  const controller = new AbortController();
  currentController = controller;

  // ADR 0080 Phase 4: 現 DOM の Frame stack を読んで request header で server に渡す。
  // server が共通祖先計算 + 共通以下 render を返してくれる契約。
  // data-layout が無い古い SSR では空配列、commonLen = 0 で full layout 経路。
  const currentFrames = Array.from(document.querySelectorAll(FRAME_SELECTOR));
  const currentLayouts = currentFrames
    .map((f) => f.getAttribute("data-layout") ?? "")
    .filter(Boolean);

  try {
    const response = await fetch(url, {
      headers: {
        Accept: "text/html;hibana-partial",
        "X-Hibana-Current-Layouts": encodeURIComponent(currentLayouts.join(",")),
      },
      credentials: "same-origin",
      signal: controller.signal,
    });

    if (!response.ok) {
      // server エラー → full reload fallback (= user に正しい error page を見せる)
      window.location.href = url;
      return;
    }

    const ok = await swapPartial(response, currentFrames);
    if (!ok) {
      // Frame marker 不在 (= layout に Frame 書き忘れ等) → full reload fallback
      window.location.href = url;
      return;
    }

    if (options.pushState) window.history.pushState(null, "", url);

    // scroll 復元 / リセット (Phase 5)
    if (options.restoreScroll) {
      const saved = sessionStorage.getItem(SCROLL_KEY(url));
      window.scrollTo(0, saved !== null ? Number(saved) : 0);
    } else {
      window.scrollTo(0, 0);
    }
  } catch (err) {
    // 後発 navigate に abort された場合は silent skip (= 後発が新 DOM を反映する、競合 OK)
    if (err instanceof DOMException && err.name === "AbortError") return;
    console.error("[hibana] navigation failed, falling back to full reload:", err);
    window.location.href = url;
  }
}

/**
 * partial response の body を共通祖先 Frame の innerHTML に直接代入する。
 *
 * ADR 0080 Phase 4 wire 仕様:
 *   - body = 共通祖先以下の layout 群 + page を nested で render したもの (= server が計算)
 *   - X-Hibana-Common-Ancestor header = commonLen (= 共通祖先 Frame の index + 1)
 *   - X-Hibana-Layouts header = 完全な new layout name stack
 *   - X-Hibana-Title header = ADR 0079 metadata の title 値
 *
 * swap target の選び方:
 *   - commonLen = 0 → 共通祖先なし (= AppLayout すら違う、完全 swap 必要) → full reload fallback
 *   - commonLen = 1 → currentFrames[0] (= Frame(AppLayout)) を swap target
 *   - commonLen = n → currentFrames[n - 1] を swap target
 *
 * 例: 現 [AppLayout, PostsLayout] → 新 [AppLayout, AboutLayout]
 *     commonLen = 1、swap = currentFrames[0] の innerHTML に partial body (= AboutLayout 以下) を代入。
 *
 * @returns 成功なら true、swap target が無い / commonLen 不整合なら false (= 呼び元で full reload fallback)。
 */
async function swapPartial(response: Response, currentFrames: Element[]): Promise<boolean> {
  if (currentFrames.length === 0) return false;

  const html = await response.text();
  // header value は server 側で encodeURIComponent 済 (= ByteString 制約回避)、
  // client 側で decodeURIComponent して復元する契約。
  const rawTitle = response.headers.get("X-Hibana-Title");
  const commonAncestorRaw = response.headers.get("X-Hibana-Common-Ancestor");
  // header 不在は ADR 0080 partial wire に準拠していない server (= 旧版 / 別実装) を意味する。
  // 安全側 = 0 (= 共通祖先なし) で false 返して full reload fallback に倒す (= ADR 0080 review C-2)。
  // ここを currentFrames.length にすると意図せず最深 frame だけ swap してしまい誤動作する。
  const commonLen = commonAncestorRaw === null ? 0 : Number(commonAncestorRaw);

  // commonLen = 0 → 共通祖先なし、full reload で完全に切り替えるしかない
  if (!Number.isFinite(commonLen) || commonLen < 1 || commonLen > currentFrames.length) {
    return false;
  }

  // 共通祖先 Frame (= 「最後に同じ」layout の Frame)、その innerHTML を partial body で
  // まるごと置換することで、それ以下の layout DOM と page DOM を新 stack のものに切り替える。
  // 注: islands の re-hydrate は別 Phase で server inline script 統合時に扱う、
  //     現状は innerHTML で <script> tag は実行されない (= state リセットなしで内容だけ更新)
  const swapTarget = currentFrames[commonLen - 1]!;
  swapTarget.innerHTML = html;

  // <title> 更新 (= ADR 0079 metadata 反映)
  if (rawTitle !== null) document.title = decodeURIComponent(rawTitle);

  return true;
}
