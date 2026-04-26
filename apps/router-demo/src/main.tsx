import { mount } from "@vidro/core";
import { Router } from "@vidro/router";

// Vite の import.meta.glob で routes/ 配下を lazy load。layout.tsx / index.tsx /
// not-found.tsx / server.ts を全部拾い、Router 内で振り分ける。
//
// 注: Step B-3b (ADR 0020) で Router 自体は hydrate-ready な構造になったが、
// main.tsx を `hydrate` に切替えるのは ErrorBoundary の anchor 対応 (B-3c)
// + JSX runtime children getter 化 (B-4、Suspense と束ねる) を待って B-3d 以降。
const routes = import.meta.glob("./routes/**/*.{ts,tsx}");

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("#app not found");
mount(() => <Router routes={routes} />, root);
