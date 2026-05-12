// 全 route に被せる global layout。app.ts で `.use("*", hibanaLayout(AppLayout))` で
// chain に組み込む。nested layout dogfood の親側 (= 子の PostsLayout / AboutLayout を内側に包む)。
//
// Step 5 (ADR 0080) dogfood: header に <Link> 化した nav を置き、`/posts` ⟷ `/about` の
// 切り替えで layout 切り替え navigation を観察する。
//
// 持続 island dogfood: header 右端の Counter は AppLayout 内 (= <Frame> の外) なので
// 全 navigation で DOM が触られず、click で増やした count が `/posts` ⟷ `/about` を
// 跨いで維持される。AboutPage 内の Counter (= <Frame> の中) と対比して観察すると、
// Step 5 の「持続 vs 消失」境界が一目で見える。

import { Link, Frame } from "@vidro/hibana";
import Counter from "../domains/posts/components/Counter.island";

export function AppLayout({ children }: { children: Node }) {
  return (
    <>
      <header style="background: #222; color: white; padding: 12px 24px; display: flex; gap: 16px; align-items: center;">
        <strong>Hibana Demo</strong>
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
        <small>nested layout dogfood (= Step 4 (3))</small>
      </footer>
    </>
  );
}
