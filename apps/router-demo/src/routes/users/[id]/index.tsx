import { currentParams, type PageProps } from "@vidro/router";
import { resource, Suspense } from "@vidro/core";
import type { loader } from "./server";

// 既存 loader 経由 SSR に加え、B-5c + ADR 0032 reactive source 動作確認の
// resource + Suspense ブロックを同居させる。bootstrapKey 付きで構築すると
// server 2-pass で resolve され、markup には posts のタイトルが焼かれた状態
// で配信される (blink なし)。/users/1 → /users/5 navigation では reactive
// source が currentParams 変化を検知して fetcher(id) を auto refetch。
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
      <h3>Posts (resource + Suspense + reactive source、ADR 0032)</h3>
      <Suspense fallback={() => <p data-testid="posts-fallback">loading posts...</p>}>
        {() => <UserPosts />}
      </Suspense>
    </section>
  );
}

type Post = { id: number; title: string };

// reactive source で currentParams.id 変化を検知 → navigation で id 変わると
// 自動 refetch される。bootstrapKey は constructor 時 (= 初回 hydrate 時) の id
// で固定 — SSR で焼いた hit を引き当てるだけ。以降の navigation は普通の
// client fetch 経路 (Suspense の fallback ↔ children swap が走る)。
function UserPosts() {
  const initialId = currentParams.value.id ?? "";
  const posts = resource(
    () => currentParams.value.id ?? null,
    (id) =>
      fetch(`https://jsonplaceholder.typicode.com/users/${id}/posts`).then(
        (r) => r.json() as Promise<Post[]>,
      ),
    { bootstrapKey: `posts:${initialId}` },
  );
  return (
    <p data-testid="posts-info">
      First post title: <strong>{posts.value?.[0]?.title ?? "..."}</strong>
    </p>
  );
}
