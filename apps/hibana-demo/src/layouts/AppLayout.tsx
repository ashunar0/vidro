// 全 route に被せる global layout。app.ts で `.use("*", hibanaLayout(AppLayout))` で
// chain に組み込む。nested layout dogfood の親側 (= 子の PostsLayout / AboutLayout を内側に包む)。
//
// Step 5 (ADR 0080) dogfood: header に <Link> 化した nav を置き、`/posts` ⟷ `/about` の
// 切り替えで layout 切り替え navigation を観察する。

import { Link, Frame } from "@vidro/hibana";

export function AppLayout({ children }: { children: Node }) {
  return (
    <>
      <header style="background: #222; color: white; padding: 12px 24px; display: flex; gap: 16px; align-items: center;">
        <strong>Hibana Demo</strong>
        <Link href="/posts">Posts</Link>
        <Link href="/about">About</Link>
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
