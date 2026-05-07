// 公開側: 全記事一覧 (`.server.tsx`)。
// invoke-once な server 評価で `getAllPosts()` を直接 call。
// signal / computed / effect は使えない (= 全部 static HTML として焼かれる)。
//
// 詳細 page は posts/[slug]/index.server.tsx で別途。

import { Link } from "@vidro/router";
import { getAllPosts } from "./server";

export default function PostsIndex() {
  // 新しい順に並べる (publishedAt desc)
  const posts = [...getAllPosts()].sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));
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
          </li>
        ))}
      </ul>
    </section>
  );
}
