import { signal } from "@vidro/core";

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

/** プログラム的に遷移する。history.pushState + signal 更新で Router が再描画する。 */
export function navigate(href: string): void {
  if (typeof window === "undefined") return;
  window.history.pushState({}, "", href);
  currentPathname.value = href;
}
