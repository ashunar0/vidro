import { Link, type PageProps } from "@vidro/router";
import type { loader } from "./server";

export default function HomePage({ data }: PageProps<typeof loader>) {
  return (
    <main>
      <h1>投稿一覧</h1>
      <ul>
        {data.posts.map((post) => (
          <div key={post.id}>
            <Link href={`/${post.id}`}>{post.title}</Link>
          </div>
        ))}
      </ul>
      <p>
        <Link href="/new">+ 新規投稿</Link>
      </p>
    </main>
  );
}
