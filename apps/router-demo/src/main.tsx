import { hydrate } from "@vidro/core";
import { Router } from "@vidro/router";

// Vite の import.meta.glob で routes/ 配下を **eager 一括取得**。SSR markup を
// hydrate する初回 render は sync でないと cursor 順が合わないため eager で
// 全 module を予め同梱する (B-3d、ADR 0027)。同 set から `routes` (= lazy 形式)
// を派生して compileRoutes に渡す形にすると、Vite の同 glob 重複 warning も
// 出ない (eager 1 経路だけで済む)。
const eagerModules = import.meta.glob("./routes/**/*.{ts,tsx}", { eager: true });
const routes = Object.fromEntries(
  Object.entries(eagerModules).map(([k, m]) => [k, () => Promise.resolve(m)]),
);

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("#app not found");

// ADR 0036: boot を registry 経由で発火する idiom。bundle は `<head>` async で
// 並列 download されるが、`<script type="module" async>` でも実行 timing は
// load 完了時点。一方 server は shell flush 直後に inline trigger
// (`__vidroBoot ? __vidroBoot() : (window.__vidroBootPending=true)`) を 1 回
// emit する。
//   - bundle が trigger より先に load 完了 → window.__vidroBoot を登録 →
//     trigger 発火時に即 hydrate (TTI 改善経路、prod 想定)
//   - bundle が trigger より遅着 → trigger は __vidroBootPending=true を flag
//     → 本コードが load 後に flag を見て即 boot
//   - dev (vite dev、shell trigger 不在) → flag も無いので DOMContentLoaded
//     fallback or 既に parse 完了なら即 boot
// boot は idempotent (booted flag で 2 重発火ガード)。
let booted = false;
const boot = (): void => {
  if (booted) return;
  booted = true;
  hydrate(() => <Router routes={routes} eagerModules={eagerModules} />, root);
};

window.__vidroBoot = boot;
if (window.__vidroBootPending) {
  // bundle 遅着経路 (= trigger 先着で flag が立っていた)。flag を消してから発火
  // (navigation や HMR で再 hydrate されるケースの safety)。
  delete window.__vidroBootPending;
  boot();
} else if (document.readyState === "loading") {
  // bundle 先着 + HTML parse 中。trigger は後で stream で届くので、評価された時点で
  // __vidroBoot() が呼ばれて boot() が走る (booted flag で 1 回保証、prod streaming
  // 経路の TTI 改善が効く本道)。trigger が届かないまま parse 完了するケース
  // (network 切断 / dev `vp dev` 経由で trigger が出ない経路) は DOMContentLoaded
  // を最終 fallback として boot を起動する。
  document.addEventListener("DOMContentLoaded", boot);
} else {
  // HTML parse 完了済 + trigger 不在 (= dev で main.tsx が遅延読込されて
  // DOMContentLoaded を逃したケース等)。即発火で fallback。
  boot();
}

declare global {
  interface Window {
    __vidroBoot?: () => void;
    __vidroBootPending?: boolean;
  }
}
