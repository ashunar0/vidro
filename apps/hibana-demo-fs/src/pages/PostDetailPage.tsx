import type { Post } from "../domains/posts/schema.ts";

export function PostDetailPage({ post }: { post: Post }) {
  return (
    <article>
      <h1>{post.title}</h1>
      <p>{post.excerpt}</p>
      <p>
        <a href="/posts">← 一覧へ</a>
      </p>
    </article>
  );
}
