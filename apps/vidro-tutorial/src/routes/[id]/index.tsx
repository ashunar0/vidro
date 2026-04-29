import { Link, type PageProps } from "@vidro/router";
import type { loader } from "./server";

export default function PostDetail({ data }: PageProps<typeof loader>) {
  return (
    <main>
      <Link href="/">← 一覧へ戻る</Link>
      {data.post ? (
        <>
          <h1>{data.post.title}</h1>
          <p>{data.post.body}</p>
          <p>{`ID: ${data.post.id}`}</p>
        </>
      ) : (
        <p>投稿が見つかりませんでした</p>
      )}
    </main>
  );
}
