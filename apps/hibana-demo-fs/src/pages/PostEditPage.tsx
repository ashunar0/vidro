import { Form } from "@vidro/hibana";
import type { Post, PostInput } from "../domains/posts/schema.ts";

// /posts/:id/edit の edit form page (= Pure server 流 / island ゼロ)。
// values は「前回 submit 失敗時の入力保持」、無ければ post の現在値で初期描画する。
// ADR 0082: <Form> 経由で submit を fetch intercept、validation 失敗時は URL 据え置き (= F2 解消)。
// PostNewPage と構造はほぼ同じだが action / 初期値元が異なる (= dogfood 段階では分けて重複を可視化、unify は痛みが顕在化したら検討)。
export type PostEditPageProps = {
  post: Post;
  values?: Partial<PostInput>;
  errors?: Record<string, string>;
};

export default function PostEditPage({ post, values, errors }: PostEditPageProps) {
  const title = values?.title ?? post.title;
  const excerpt = values?.excerpt ?? post.excerpt;
  return (
    <div>
      <h1>Edit Post #{post.id}</h1>
      <Form method="POST" action={`/posts/${post.id}`}>
        <p>
          <label for="title">Title</label>
          <br />
          <input id="title" name="title" type="text" value={title} />
          {errors?.title ? <span class="error"> — {errors.title}</span> : null}
        </p>
        <p>
          <label for="excerpt">Excerpt</label>
          <br />
          <textarea id="excerpt" name="excerpt" rows={3}>
            {excerpt}
          </textarea>
          {errors?.excerpt ? <span class="error"> — {errors.excerpt}</span> : null}
        </p>
        <p>
          <button type="submit">Update</button> <a href={`/posts/${post.id}`}>Cancel</a>
        </p>
      </Form>
    </div>
  );
}
