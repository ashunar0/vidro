import { signal } from "@vidro/core";

// 現在の pathname を保持する module scope singleton。Router が subscribe し、
// Link / navigate() が更新する。最小版では Router は 1 app につき 1 個前提なので
// singleton で十分 (複数 Router / SSR は後で context に移行)。
export const currentPathname = signal(
  typeof window !== "undefined" ? window.location.pathname : "/",
);

/** プログラム的に遷移する。history.pushState + signal 更新で Router が再描画する。 */
export function navigate(href: string): void {
  if (typeof window === "undefined") return;
  window.history.pushState({}, "", href);
  currentPathname.value = href;
}
