import { hydrate } from "@vidro/core";
import { Router } from "./router";
import type { RouteRecord } from "./route-tree";

// `<head>` 経由の inline trigger と client bundle の load 順序競合を捌く registry
// (ADR 0036)。boot() がここに登録 / 参照する。
declare global {
  interface Window {
    __vidroBoot?: () => void;
    __vidroBootPending?: boolean;
  }
}

/**
 * Vidro app の bootstrap helper (ADR 0044)。user の `src/main.tsx` から:
 *
 * ```ts
 * import { boot } from "@vidro/router/client";
 * boot(import.meta.glob("./routes/**\/*.{ts,tsx}", { eager: true }));
 * ```
 *
 * 内包する責務:
 *   - eagerModules → lazy `RouteRecord` 派生 (Vite の glob 重複 warning 回避、ADR 0027)
 *   - `#app` 探索 + 不在時 throw
 *   - ADR 0036 の boot registry idiom (bundle / shell trigger の load 順序競合)
 *   - `DOMContentLoaded` fallback と即発火 fallback (dev / 遅延読込時)
 *   - `booted` flag による 2 重発火ガード
 *
 * これらは全て framework 内部の race / convention であり、user code には漏らさない。
 */
export function boot(eagerModules: Record<string, unknown>): void {
  // lazy 形式は同 set からの派生で済ませる (Vite の同 glob 重複 warning 回避)。
  const routes: RouteRecord = Object.fromEntries(
    Object.entries(eagerModules).map(([k, m]) => [k, () => Promise.resolve(m)]),
  );

  const root = document.querySelector<HTMLDivElement>("#app");
  if (!root) throw new Error("#app not found");

  let booted = false;
  const fire = (): void => {
    if (booted) return;
    booted = true;
    // Router は component 関数 `(props) => Node`。`h(Router, ...)` 経由は ComponentFn
    // 型 (props: Record<string, unknown>) と RouterProps の narrowing で TS が
    // 通らないため直接呼ぶ。fine-grained reactive では `h()` か直呼出しかは挙動
    // 同等 (内部で同じ Component(props) を実行する)。
    hydrate(() => Router({ routes, eagerModules }), root);
  };

  window.__vidroBoot = fire;
  if (window.__vidroBootPending) {
    // bundle 遅着経路 (= trigger 先着で flag が立っていた)。flag を消してから発火。
    delete window.__vidroBootPending;
    fire();
  } else if (document.readyState === "loading") {
    // bundle 先着 + HTML parse 中。trigger が後で stream で届けば即 fire、
    // 届かないまま parse 完了するケース (network 切断 / dev 経由) は
    // DOMContentLoaded を最終 fallback として boot を起動する。
    document.addEventListener("DOMContentLoaded", fire);
  } else {
    // HTML parse 完了済 + trigger 不在 (= dev で main.tsx が遅延読込されて
    // DOMContentLoaded を逃したケース等)。即発火で fallback。
    fire();
  }
}
