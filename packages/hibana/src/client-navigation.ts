// @vidro/hibana/client-navigation — Step 5 (HTML swap navigation) の client runtime。
//
// ADR 0080 Phase 2-3: <Link> の click intercept + partial wire fetch + 最深 Frame swap。
// 同 layout 内 navigation の実装 (= 共通祖先計算は Phase 4 で拡張)。
//
// 制約 (= 後続 Phase で解消):
//   - layout 切り替え (= /posts → /about) は最深 Frame swap で済ます or full reload fallback
//     (= layout stack 比較は Phase 4 で対応)
//   - islands re-hydrate なし (= Counter state リセット、後で server inline script 統合時に対応)
//   - dev warning / scroll restoration / popstate は Phase 5 で
//
// Wire 仕様 (= ADR 0080 §Wire spec):
//   request:  GET <url>  Accept: text/html;hibana-partial
//   response: HTTP/1.1 200 OK
//             X-Hibana-Layouts: AppLayout,PostsLayout
//             X-Hibana-Title:   <new title>
//             Content-Type:     text/html
//             <raw page body for innermost Frame, no wrapper>
//
// 設計判断: ADR 0080 §機構 #3 (client navigation runtime)。
// 関連 memory: [[project_hibana_step5_design]]

const LINK_SELECTOR = "a[data-hibana-link]";
const FRAME_SELECTOR = "hibana-frame[data-hibana-frame]";

/**
 * Step 5 navigation runtime の setup。app の client bundle entry (= virtual:hibana/client-entry)
 * から 1 回呼ぶ。冪等: 2 度目以降の setup は no-op。
 *
 * 流れ:
 *   1. document に click event listener 追加 (capture: false、bubble phase)
 *   2. event.target を closest("a[data-hibana-link]") で検索、なければ skip
 *      (= 素の `<a>` は browser default の MPA 遷移、graceful degradation)
 *   3. 修飾キー / 中クリック / 外部リンク / download attr 等は browser default に委ねる
 *   4. preventDefault + fetch(url) で次 page の HTML 取得
 *   5. DOMParser で parse + 最深 `<hibana-frame data-hibana-frame>` の中身を抽出
 *   6. 現 DOM の最深 frame の innerHTML を新 content で差し替え
 *   7. history.pushState で URL 更新 + document.title 更新 (= ADR 0079 metadata)
 *
 * 失敗時 (= Frame 不在 / fetch エラー / 5xx) は full reload に fallback
 * (= graceful degradation、user 哲学整合)。
 */
export function setupNavigation(): void {
  if (typeof window === "undefined") return;

  const w = window as Window & { __hibanaNavigationSetup?: true };
  if (w.__hibanaNavigationSetup) return;
  w.__hibanaNavigationSetup = true;

  document.addEventListener("click", handleClick);
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

  const url = link.href;

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

    window.history.pushState(null, "", url);
  } catch (err) {
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
  const commonLen = commonAncestorRaw === null ? currentFrames.length : Number(commonAncestorRaw);

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
