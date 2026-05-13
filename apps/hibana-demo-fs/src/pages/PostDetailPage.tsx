import { Form } from "@vidro/hibana";
import type { Post } from "../domains/posts/schema.ts";

export function PostDetailPage({ post }: { post: Post }) {
  return (
    <article>
      <h1>{post.title}</h1>
      <p>{post.excerpt}</p>
      <p>
        <a href="/posts">← 一覧へ</a>
        {" / "}
        <a href={`/posts/${post.id}/edit`}>Edit</a>
      </p>
      {/* delete は副作用 (= state mutation) なので a 単独でなく form POST で送る (= GET で削除はブラウザ prefetch / spider で誤発火する)。 */}
      {/* ADR 0082: <Form> で submit intercept、成功 redirect (/posts) は partial swap + pushState で SPA 風遷移。 */}
      <Form method="POST" action={`/posts/${post.id}/delete`}>
        <button type="submit">Delete</button>
      </Form>
    </article>
  );
}
