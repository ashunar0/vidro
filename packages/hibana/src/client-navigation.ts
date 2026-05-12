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

  try {
    // ADR 0080 Phase 3: partial wire を要求する。server side が Accept header を見て
    // partial / full を切り替える。tolerant server (= 未対応 Hibana 実装) には Accept
    // header を無視して full HTML を返すケースもあるので、Content-Type で判定して fallback。
    const response = await fetch(url, {
      headers: { Accept: "text/html;hibana-partial" },
      credentials: "same-origin",
    });

    if (!response.ok) {
      // server エラー → full reload fallback (= user に正しい error page を見せる)
      window.location.href = url;
      return;
    }

    const ok = await swapPartial(response);
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
 * partial response の body を現 DOM の最深 `<hibana-frame data-hibana-frame>` に
 * 直接代入する。
 *
 * partial wire 仕様 (= ADR 0080 §Wire spec):
 *   - body = 純粋な page content (= 最深 Frame の中身、wrapper 無し)
 *   - X-Hibana-Title header = ADR 0079 metadata の title 値
 *   - X-Hibana-Layouts header = layout name list (= Phase 4 で共通祖先計算に使う)
 *
 * 「最深」= NodeList の最後の entry。document order で後ろに来る = 入れ子の内側、なので
 * 親 layout > 子 layout > page の nested 構造なら最も内側の Frame が最後の要素になる
 * (Phase 4 で共通祖先計算に拡張、X-Hibana-Layouts を比較して swap 範囲を決定)。
 *
 * @returns 成功なら true、現 DOM に frame marker が無ければ false。
 */
async function swapPartial(response: Response): Promise<boolean> {
  const currentFrames = document.querySelectorAll(FRAME_SELECTOR);
  if (currentFrames.length === 0) return false;

  const html = await response.text();
  const title = response.headers.get("X-Hibana-Title");

  // partial body は最深 Frame の中身として直接代入できる (= server が wrapper 抜きで送る契約)
  // 注: islands の re-hydrate は別 Phase で server inline script 統合時に扱う、
  //     現状は innerHTML で <script> tag は実行されない (= state リセットなしで内容だけ更新)
  const currentInnerFrame = currentFrames[currentFrames.length - 1]!;
  currentInnerFrame.innerHTML = html;

  // <title> 更新 (= ADR 0079 metadata 反映)
  if (title !== null) document.title = title;

  return true;
}
