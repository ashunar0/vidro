import { mount } from "@vidro/core";
import { Router, Link } from "@vidro/router";

// Vite の import.meta.glob で routes/ 配下を lazy load。最小版は index.tsx と
// not-found.tsx のみ拾う方針なので、pattern もそれに合わせる。
const routes = import.meta.glob("./routes/**/*.tsx");

function App() {
  return (
    <div style="font-family: system-ui, sans-serif; padding: 2rem; max-width: 640px; margin: 0 auto;">
      <h1>Vidro Router Demo</h1>
      <nav style="display: flex; gap: 0.75rem; padding: 0.5rem 0; border-bottom: 1px solid #ccc;">
        <Link href="/">Home</Link>
        <Link href="/about">About</Link>
        <Link href="/users">Users</Link>
        <Link href="/users/1">User 1</Link>
        <Link href="/users/42">User 42</Link>
        <Link href="/does-not-exist">404</Link>
      </nav>
      <main style="padding-top: 1rem;">
        <Router routes={routes} />
      </main>
    </div>
  );
}

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("#app not found");
mount(() => <App />, root);
