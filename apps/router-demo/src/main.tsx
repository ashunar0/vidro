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

// SSR で焼かれた #app 内の markup を再利用する hydrate 経路。Router 内部で
// bootstrapData (`<script id="__vidro_data">`) を読み、eagerModules + match で
// sync fold し、HydrationRenderer cursor が既存 DOM と整合する。
hydrate(() => <Router routes={routes} eagerModules={eagerModules} />, root);
