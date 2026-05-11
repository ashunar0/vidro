import type { Post } from "../schema.ts";

// PostListPage は props.posts を「定数 snapshot」として受け取る。
// 設計書「server は reactivity を知らない」原則: server から渡されるのは静的データ、
// reactive にしたければ client 側 (= island) で signal / store に入れ直す。
//
// Phase 1 Step 1 では island がまだ無いので、純粋に static HTML として焼かれる。
export function PostListPage({ posts }: { posts: Post[] }) {
  return (
    <div>
      <h1>Posts</h1>
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
