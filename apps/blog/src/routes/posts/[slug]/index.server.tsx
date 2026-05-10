// 公開側: 記事詳細 (`.server.tsx`)。
// ADR 0066 dogfood: async function component で `await getPost(...)` を直書き。
// ADR 0067: `./+types` per-route codegen 経由で `Route.PageProps` を引く。
// ファイル位置 `[slug]` が single source of truth、params.slug は string で型推論される。
//
// dogfood 第 8 周目 (2026-05-10): db 直叩き → getPost / listPosts serverFn 経由に変更。
// getPost は nullable 戻り値を維持 (= 「Post not found」UI を出すため)、write 系の
// 404 throw とは asymmetric (= read は URL ミス想定、write は state divergence 想定)。

import { Link } from "@vidro/router";
import { getPost, listPosts } from "../../../features/posts/server";
import type { Route } from "./+types";

export default async function PostDetail({ params }: Route.PageProps) {
  const post = await getPost({ params: { slug: params.slug } });
  if (!post) {
    return (
      <article>
        <h2 class="text-xl font-semibold">Post not found</h2>
        <p class="mt-2 text-sm">
          <Link href="/posts" class="text-blue-600 hover:underline">
            ← Back to all posts
          </Link>
        </p>
      </article>
    );
  }

  // 隣接 post を全件 (publishedAt desc 済) から計算。toy data 量なので全 fetch で良い
  // (= 本格的な blog なら index 経由で前後 1 件だけ select する SQL に置換)。
  const all = await listPosts();
  const idx = all.findIndex((p) => p.slug === post.slug);
  const newer = idx > 0 ? all[idx - 1] : null;
  const older = idx >= 0 && idx < all.length - 1 ? all[idx + 1] : null;

  return (
    <article>
      <p class="mb-2 text-sm">
        <Link href="/posts" class="text-blue-600 hover:underline">
          ← Back to all posts
        </Link>
      </p>
      <h2 class="text-2xl font-bold">{post.title}</h2>
      <p class="mt-1 text-xs text-gray-400">{post.publishedAt}</p>
      <p class="mt-6 leading-relaxed">{post.body}</p>

      <nav class="mt-10 flex justify-between border-t border-gray-200 pt-4 text-sm">
        {older ? (
          <Link href={`/posts/${older.slug}`} class="text-blue-600 hover:underline">
            {`← ${older.title}`}
          </Link>
        ) : (
          <span />
        )}
        {newer ? (
          <Link href={`/posts/${newer.slug}`} class="text-blue-600 hover:underline">
            {`${newer.title} →`}
          </Link>
        ) : (
          <span />
        )}
      </nav>
    </article>
  );
}
