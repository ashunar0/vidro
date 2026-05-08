// 公開側: 全記事一覧 (`.server.tsx`)。
// ADR 0066 dogfood: `async function Component() { const posts = await db.postsAsync(); ... }`
// 直書き形式。core の h() が Promise<Node> を VAsyncSlot に包んで AsyncScope に register、
// renderToReadableStream / renderToStringAsync の allSettled 待ち合わせ後に markup に展開される。
// signal / computed / effect は使えない (= 全部 static HTML として焼かれる、ADR 0058)。
//
// 詳細 page は posts/[slug]/index.server.tsx で別途。

import { Link } from "@vidro/router";
import { db } from "./server";

export default async function PostsIndex() {
  const posts = await db.postsAsync();

  return (
    <section>
      <h2 class="text-xl font-semibold">All posts</h2>
      <ul class="mt-4 space-y-4">
        {posts.map((p) => (
          <li class="rounded border border-gray-200 px-4 py-3">
            {/* Link children は 1 expression に畳む。複数 thunk children を
                 配列で渡すと core の _$dynamicChild Array branch が auto-invoke
                 しない既知制約があるため、template literal で 1 つにする */}
            <Link href={`/posts/${p.slug}`} class="font-semibold text-blue-600 hover:underline">
              {p.title}
            </Link>
            <p class="mt-1 text-xs text-gray-400">{p.publishedAt}</p>
            <p class="mt-2 text-sm text-gray-700">{p.body}</p>
            <div class="mt-2 flex gap-3 text-sm">
              <Link href={`/posts/${p.slug}/edit`} class="text-blue-600 hover:underline">
                Edit
              </Link>
              {/* ADR 0068 dogfood: resource route で delete を受ける。
                   `/posts/[slug]/delete/server.ts` 単独 directory が action only
                   route として認識される (= 痛み点 6 解消)。一覧 page は async
                   server component なので pending/error 表示は依然なし — JS-rich UX
                   が必要なら row ごと island 化する (= ADR 0069 別軸の応用)。 */}
              <form method="post" action={`/posts/${p.slug}/delete`} class="inline">
                <button type="submit" class="text-red-600 hover:underline">
                  Delete
                </button>
              </form>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
