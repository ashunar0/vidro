// ADR 0058 + 0060 dogfood — 詳細 page (`.server.tsx`)。
// LikeButton island を 2 つ配置して reviewer M-1 「同 component の複数 instance を
// 区別できる」を実機で確認する。1 つ目は initial=0、2 つ目は initial=10 で異なる
// 初期値。SSR で別 marker (`vi-LikeButton-1` / `vi-LikeButton-2`) が emit され、
// hydrate 後に独立してカウントが回るはず。
//
// params は PageProps の `params` を分割代入で受け取る。`.server.tsx` は loader
// を持たない (= ADR 0058 D-α-iii) ので PageProps generic は不要、{ params } 直書きで OK。

import { Link } from "@vidro/router";
import { getPostById } from "../server";
import { LikeButton } from "../like-button";

// 注: 今は sync (ADR 0058 想定の async component は core 側未対応)
export default function PostDetail({ params }: { params: { id: string } }) {
  const post = getPostById(Number(params.id));
  if (!post) {
    return (
      <div>
        <h2 class="text-xl font-semibold">Post not found</h2>
        <p class="mt-2">
          <Link href="/posts" class="text-blue-500 hover:underline">
            ← Back to list
          </Link>
        </p>
      </div>
    );
  }
  return (
    <article>
      <p class="mb-2">
        <Link href="/posts" class="text-sm text-blue-500 hover:underline">
          ← Back to list
        </Link>
      </p>
      <h2 class="text-2xl font-bold">{post.title}</h2>
      <p class="mt-1 text-xs text-gray-400">{post.createdAt}</p>
      <p class="mt-4 leading-relaxed">{post.text}</p>

      <div class="mt-6 flex gap-3">
        {/* island #1: 初期値 0 */}
        <LikeButton initial={0} />
        {/* island #2: 初期値 10 (= 同 component 複数 instance を区別する dogfood) */}
        <LikeButton initial={10} />
      </div>
    </article>
  );
}
