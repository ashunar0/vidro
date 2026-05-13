import type { PostInput } from "../schema.ts";

// /posts/new の create form page (= Pure server 流 / island ゼロ)。
// values = 前回 submit 失敗時の入力保持、errors = zod validation 失敗時の field name → message map。
// MPA: <form method="POST" action="/posts"> で submit → server で validation → 成功 redirect / 失敗で同 page render。
export type PostNewPageProps = {
  values?: Partial<PostInput>;
  errors?: Record<string, string>;
};

export default function PostNewPage({ values, errors }: PostNewPageProps) {
  return (
    <div>
      <h1>New Post</h1>
      <form method="POST" action="/posts">
        <p>
          <label for="title">Title</label>
          <br />
          <input id="title" name="title" type="text" value={values?.title ?? ""} />
          {errors?.title ? <span class="error"> — {errors.title}</span> : null}
        </p>
        <p>
          <label for="excerpt">Excerpt</label>
          <br />
          <textarea id="excerpt" name="excerpt" rows={3}>
            {values?.excerpt ?? ""}
          </textarea>
          {errors?.excerpt ? <span class="error"> — {errors.excerpt}</span> : null}
        </p>
        <p>
          <button type="submit">Create</button> <a href="/posts">Cancel</a>
        </p>
      </form>
    </div>
  );
}
