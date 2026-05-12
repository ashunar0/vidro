import type { Post } from "../domains/posts/schema.ts";
import Counter from "../domains/posts/components/Counter.island.tsx";

// filesystem-based 版の PostListPage。handler-based 版 (= apps/hibana-demo) と異なる点:
//   - default export しない (= filesystem-based では route file の default export が handler)
//   - `export const metadata` は route file (= app/routes/posts/index.tsx) 側に書く (= 解 a)
//
// 純粋な UI component として責務を絞れている (= filesystem 規約の利点)。
export function PostListPage({ posts }: { posts: Post[] }) {
  return (
    <div>
      <h1>Posts</h1>
      <Counter initial={0} />
      <ul>
        {posts.map((post) => (
          <li key={post.id}>
            <h2>{post.title}</h2>
            <p>{post.excerpt}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
