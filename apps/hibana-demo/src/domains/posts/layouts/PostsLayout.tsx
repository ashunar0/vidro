// /posts/* 配下に被せる scoped layout。posts/routes.ts の chain に
// `.use("*", hibanaLayout(PostsLayout))` で組み込む。nested の子側 (= AppLayout の内側)。
//
// 配置: layout は **domain folder 内** に置けるべきという哲学を体現 (= 設計書「3. UI は
// route でなく domain で組織」)。app 全体共通の AppLayout は src/layouts/ に、posts 固有の
// PostsLayout は src/domains/posts/layouts/ に。layout 配置は強制せず推奨。
//
// Step 5 (ADR 0080) dogfood: <Frame>{children}</Frame> で boundary marker 配置 + sidebar の
// 内部リンクを <Link> 化して partial wire 経由の SPA 風 navigation を発火させる。
// sidebar 自体は Frame の外側なので navigation 後も保持される (= persistent layout)。

import { Link, Frame } from "@vidro/hibana";

export function PostsLayout({ children }: { children: Node }) {
  return (
    <div style="display: flex; gap: 24px; padding: 24px;">
      <aside data-testid="posts-sidebar" style="width: 200px; background: #fafafa; padding: 16px;">
        <strong>Posts</strong>
        <nav style="margin-top: 8px; display: flex; flex-direction: column; gap: 4px;">
          <Link href="/posts">All posts</Link>
          <Link href="/posts/1">#1</Link>
          <Link href="/posts/2">#2</Link>
          <Link href="/posts/3">#3</Link>
        </nav>
      </aside>
      <main data-testid="posts-main" style="flex: 1;">
        <Frame>{children}</Frame>
      </main>
    </div>
  );
}
