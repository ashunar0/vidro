import { mount } from "@vidro/core";
import { Router } from "@vidro/router";

// Vite の import.meta.glob で routes/ 配下を lazy load。layout.tsx / index.tsx /
// not-found.tsx を全部拾い、Router 内で振り分ける。
const routes = import.meta.glob("./routes/**/*.tsx");

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("#app not found");
mount(() => <Router routes={routes} />, root);
