// 公開側: 記事詳細 (`.server.tsx`)。
// `.server.tsx` は loader を持たない (= ADR 0058 D-α-iii) ので PageProps generic
// は不要、{ params } 直書きで OK。

import { Link } from "@vidro/router";
import { db } from "../server";

export default function PostDetail({ params }: { params: { slug: string } }) {
  const post = db.postBySlug(params.slug);
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

  // 隣接 post を db.posts (publishedAt desc 済) から計算
  const idx = db.posts.findIndex((p) => p.slug === post.slug);
  const newer = idx > 0 ? db.posts[idx - 1] : null;
  const older = idx < db.posts.length - 1 ? db.posts[idx + 1] : null;

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
