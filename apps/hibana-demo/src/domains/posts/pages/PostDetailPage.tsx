import type { Post } from "../schema.ts";
import type { Metadata } from "@vidro/hibana";

// ADR 0079 dogfood: static metadata (= function ではなく object) のケース。
// dynamic な MetadataFn<P> と違い、props に依存しない場合は object 形式が簡潔。
// 同 route で常に同じ title/description を返すケース (= 一覧画面、利用規約、お問い合わせ 等) で出番。
export const metadata: Metadata = {
  title: "Post Detail — Hibana Demo",
  description: "個別 post の表示画面。static metadata の dogfood サンプル。",
};

export default function PostDetailPage({ post }: { post: Post }) {
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
      <form method="POST" action={`/posts/${post.id}/delete`}>
        <button type="submit">Delete</button>
      </form>
    </article>
  );
}
