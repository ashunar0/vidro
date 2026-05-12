// /posts/* 配下に被せる scoped layout。posts/routes.ts の chain に
// `.use("*", hibanaLayout(PostsLayout))` で組み込む。nested の子側 (= AppLayout の内側)。
//
// 配置: layout は **domain folder 内** に置けるべきという哲学を体現 (= 設計書「3. UI は
// route でなく domain で組織」)。app 全体共通の AppLayout は src/layouts/ に、posts 固有の
// PostsLayout は src/domains/posts/layouts/ に。layout 配置は強制せず推奨。

export function PostsLayout({ children }: { children: Node }) {
  return (
    <div style="display: flex; gap: 24px; padding: 24px;">
      <aside data-testid="posts-sidebar" style="width: 200px; background: #fafafa; padding: 16px;">
        <strong>Posts</strong>
        <nav style="margin-top: 8px; display: flex; flex-direction: column; gap: 4px;">
          <a href="/posts">All posts</a>
          <a href="/posts/1">#1</a>
          <a href="/posts/2">#2</a>
          <a href="/posts/3">#3</a>
        </nav>
      </aside>
      <main data-testid="posts-main" style="flex: 1;">
        {children}
      </main>
    </div>
  );
}
