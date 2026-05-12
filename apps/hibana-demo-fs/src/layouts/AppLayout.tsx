// 全 route に被せる global layout (filesystem-based 版)。
// src/routes/_renderer.tsx で default 再 export されて、root 配下全 route に適用される。
//
// Step 5 (ADR 0080) dogfood (両 app): <Frame>{children}</Frame> + <Link> で
// partial navigation を発火、persistent layout を試す。ADR 0080 が「ADR 0081 = layout 機構の
// 本採用判断」に中立であることを実証する Phase 6 dogfood。
//
// 持続 island dogfood: header 右端の Counter は AppLayout 内 (= <Frame> の外) なので
// 全 navigation で DOM が触られず、click で増やした count が `/posts` ⟷ `/about` を
// 跨いで維持される。AboutPage 内の Counter (= <Frame> の中) と対比して観察。

import { Link, Frame } from "@vidro/hibana";
import Counter from "../domains/posts/components/Counter.island";

export function AppLayout({ children }: { children: Node }) {
  return (
    <>
      <header style="background: #222; color: white; padding: 12px 24px; display: flex; gap: 16px; align-items: center;">
        <strong>Hibana Demo (fs)</strong>
        <Link href="/posts">Posts</Link>
        <Link href="/about">About</Link>
        <span style="margin-left: auto; display: flex; gap: 8px; align-items: center;">
          <small>Persistent:</small>
          <Counter initial={0} />
        </span>
      </header>
      <div data-testid="app-layout-content">
        <Frame>{children}</Frame>
      </div>
      <footer style="background: #f5f5f5; padding: 12px 24px; margin-top: 32px;">
        <small>filesystem-based dogfood (= Step 4 (3) / Step 5)</small>
      </footer>
    </>
  );
}
