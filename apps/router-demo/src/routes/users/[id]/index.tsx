import type { PageProps } from "@vidro/router";
import { createResource, Suspense } from "@vidro/core";
import type { loader } from "./server";

// 既存 loader 経由 SSR に加え、B-5c 動作確認の createResource + Suspense ブロックを
// 同居させる。bootstrapKey 付きで構築すると server 2-pass で resolve され、
// markup には posts のタイトルが焼かれた状態で配信される (blink なし)。
export default function UserPage({ data, params }: PageProps<typeof loader>) {
  return (
    <section>
      <h2>User</h2>
      <p>
        Path param ID: <strong>{params.id}</strong>
      </p>
      <p>
        Name: <strong>{data.user.name}</strong>
      </p>
      <p>
        Email: <strong>{data.user.email}</strong>
      </p>
      <p>
        (loader が <code>./server.ts</code> から fetch したのだ。
        <code>typeof loader</code> 経由で型貫通)
      </p>
      <hr />
      <h3>Posts (createResource + Suspense, B-5c)</h3>
      <Suspense fallback={() => <p data-testid="posts-fallback">loading posts...</p>}>
        {() => <UserPosts userId={params.id} />}
      </Suspense>
    </section>
  );
}

type Post = { id: number; title: string };

// createResource を Suspense の children 内で構築。bootstrapKey 一意化のため
// `posts:${userId}` を渡す。server 2-pass で resolve → bootstrap data 同居 →
// client constructor が hit を引き当てて loading=false スタート (B-5c)
function UserPosts({ userId }: { userId: string }) {
  const posts = createResource<Post[]>(
    () =>
      fetch(`https://jsonplaceholder.typicode.com/users/${userId}/posts`).then(
        (r) => r.json() as Promise<Post[]>,
      ),
    { bootstrapKey: `posts:${userId}` },
  );
  return (
    <p data-testid="posts-info">
      First post title: <strong>{posts.value?.[0]?.title ?? "..."}</strong>
    </p>
  );
}
