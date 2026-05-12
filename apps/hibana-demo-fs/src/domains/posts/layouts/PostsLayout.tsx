// /posts/* 配下に被せる scoped layout (filesystem-based 版)。
// src/routes/posts/_renderer.tsx で default 再 export される。
//
// 配置: layout は **domain folder 内** に置けるべきという哲学を体現 (= 設計書「3. UI は
// route でなく domain で組織」)。filesystem 規約の薄い橋渡しは _renderer.tsx 側で、
// 実 component は domain folder に置く (= 物理配置は強制せず推奨)。
//
// Step 5 (ADR 0080) dogfood: sidebar の <a> を <Link> 化、<Frame>{children}</Frame> で
// boundary marker 配置。handler-based 版 (= apps/hibana-demo) と同じ書き味で動くことを実証。

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
