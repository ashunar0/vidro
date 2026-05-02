import { signal } from "@vidro/core";
import { _syncSearchParamsFromUrl } from "./search-params";

// 現在の pathname を保持する module scope singleton。Router が subscribe し、
// Link / navigate() が更新する。最小版では Router は 1 app につき 1 個前提なので
// singleton で十分 (複数 Router / SSR は後で context に移行)。
export const currentPathname = signal(
  typeof window !== "undefined" ? window.location.pathname : "/",
);

/**
 * 現在 match している全 layer の params を保持する signal。Router が match 解決後に
 * 更新する (server SSR / client navigation / hydrate sync 経路すべて)。深い子孫が
 * `PageProps.params` の prop drilling 無しで params を読めるようにする補助 API。
 *
 * 値は最深 match の params ですべての layer 分が merge 済 (route-tree が `:id` 等を
 * 各 layer で抽出して 1 つの map に統合)。
 *
 * Workers 並行 request の race 注意は currentPathname と同じく
 * project_pending_rewrites に記録 (将来 context-based に書き換え予定)。
 */
export const currentParams = signal<Record<string, string>>({});

/**
 * プログラム的に遷移する。history.pushState + signal 更新で Router が再描画する。
 *
 * ADR 0052: pushState 後に `_syncSearchParamsFromUrl()` を呼んで、searchParams() で
 * 取得済の signals を新 URL の search 部分と同期させる。これで `<Link href="?page=2">`
 * のような search-only navigation でも searchParams 経由 reactive UI が追従する。
 *
 * pathname は pushState 後の `window.location.pathname` から再読み込み。引数 href が
 * relative URL ("?page=2" / "../foo" 等) でも正しい絶対 pathname に解決される。
 *
 * **search-only URL (`?page=2` 等) の挙動**: pushState は走るが pathname は変わらない
 * ため `currentPathname` への同値 set は signal の `Object.is` ガードで notify されず、
 * Router の effect は再 fire しない (= loader は再実行されない)。これは Path Y の
 * 設計意図と整合する: search 変化は client URL state のみで処理され、loader 再実行が
 * 必要なら `revalidate()` を別途呼ぶ。`searchParams()` で取得した signals 自体は
 * `_syncSearchParamsFromUrl()` 経由で新値が反映されるので、derive 系 UI は追従する。
 */
export function navigate(href: string): void {
  if (typeof window === "undefined") return;
  window.history.pushState({}, "", href);
  _syncSearchParamsFromUrl();
  currentPathname.value = window.location.pathname;
}
