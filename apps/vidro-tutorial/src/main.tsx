import { hydrate } from "@vidro/core";
import { Router } from "@vidro/router";

// routes/ 配下を eager 一括取得。SSR markup を hydrate する初回 render は sync で
// ないと cursor 順が合わないため、全 module を予め同梱する。
const eagerModules = import.meta.glob("./routes/**/*.{ts,tsx}", { eager: true });
const routes = Object.fromEntries(
  Object.entries(eagerModules).map(([k, m]) => [k, () => Promise.resolve(m)]),
);

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("#app not found");

// boot を registry 経由で発火する idiom (ADR 0036、TTI 改善)。
//   - bundle が shell trigger より先に load → window.__vidroBoot を登録、trigger 発火時に即 hydrate
//   - bundle が遅着 → trigger が __vidroBootPending を立てておく、bundle load 後に flag を見て即 boot
//   - dev (trigger 不在) → DOMContentLoaded fallback or 即 boot
// boot は idempotent (booted flag で 2 重発火ガード)。
let booted = false;
const boot = (): void => {
  if (booted) return;
  booted = true;
  hydrate(() => <Router routes={routes} eagerModules={eagerModules} />, root);
};

window.__vidroBoot = boot;
if (window.__vidroBootPending) {
  delete window.__vidroBootPending;
  boot();
} else if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}

declare global {
  interface Window {
    __vidroBoot?: () => void;
    __vidroBootPending?: boolean;
  }
}
