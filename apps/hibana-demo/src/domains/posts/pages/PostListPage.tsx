import type { Post } from "../schema.ts";
import type { MetadataFn } from "@vidro/hibana";
import Counter from "../components/Counter.island.tsx";

// PostListPage は props.posts を「定数 snapshot」として受け取る。
// 設計書「server は reactivity を知らない」原則: server から渡されるのは静的データ、
// reactive にしたければ client 側 (= island) で signal / store に入れ直す。
//
// Step 2 から: Counter (= island) を埋め込む。SSR では Counter のクリック前の markup と
// marker が焼かれ、client bundle が hydrate で event listener と reactive update を attach する。
//
// Step 4 (ADR 0079): per-route head は `export const metadata` で。dynamic は MetadataFn<P>
// で props を受け取って Metadata を返す形 (= ここでは posts.length を title に流す dogfood)。
// Vite plugin (= @vidro/hibana/vite) が transform で default export function に
// `.metadata` プロパティを attach、middleware の renderer がそれを読んで shell HTML の
// <head> に inject する。
export const metadata: MetadataFn<{ posts: Post[] }> = ({ posts }) => ({
  title: `Posts (${posts.length})`,
  description: "Hibana demo の posts 一覧。ADR 0079 dogfood で per-route head を試している。",
  meta: [{ property: "og:title", content: `Posts (${posts.length})` }],
  link: [{ rel: "canonical", href: "/posts" }],
});

export default function PostListPage({ posts }: { posts: Post[] }) {
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
