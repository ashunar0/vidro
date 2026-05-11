import type { Post } from "../schema.ts";
import Counter from "../components/Counter.island.tsx";

// PostListPage は props.posts を「定数 snapshot」として受け取る。
// 設計書「server は reactivity を知らない」原則: server から渡されるのは静的データ、
// reactive にしたければ client 側 (= island) で signal / store に入れ直す。
//
// Step 2 から: Counter (= island) を埋め込む。SSR では Counter のクリック前の markup と
// marker が焼かれ、client bundle が hydrate で event listener と reactive update を attach する。
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
