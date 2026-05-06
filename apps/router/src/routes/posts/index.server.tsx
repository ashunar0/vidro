// ADR 0058 dogfood — server-only component file (`.server.tsx`)。
// invoke-once な server 評価で、await が直接書ける + signal/computed/effect は build error。
//
// ADR 0060 dogfood — このファイル内に Client Component (`.tsx` import) を配置すると
// jsx-transform が `<__VidroIsland>` で wrap し、SSR で marker emit + registry push、
// client で hydrate される。本 page は island なし (= 一覧表示は完全 static)、詳細
// page (`[id]/index.server.tsx`) で LikeButton island を配置する。
//
// データ取得: `getAllPosts()` を直 await。`/__loader` 経由ではない (= ADR 0058 D-α-iii)。

import { Link } from "@vidro/router";
import { getAllPosts } from "./server";

// 注: 今は sync。ADR 0058 が想定する async component (= `await db.x()`) は core h() が
// sync 呼び出しなので未サポート、別 task で対応 (project_pending_rewrites 参照)。
export default function PostsPage() {
  const posts = getAllPosts();
  return (
    <div>
      <h2 class="text-xl font-semibold">Posts (server-only)</h2>
      <p class="mt-1 text-xs text-gray-500">
        (debug) このページは <code>.server.tsx</code> なので signal / computed / effect は
        使えない。一覧の文字列は全部 server で焼かれた static HTML。
      </p>
      <ul class="mt-4 space-y-3">
        {posts.map((p) => (
          <li class="rounded border px-3 py-2">
            {/* Link children を template literal にして 1 expression 化。
                 複数 thunk children を配列で渡すと _$dynamicChild の Array branch
                 が配列内 function を auto-invoke しないため空文字化する core 既知制約 */}
            <Link href={`/posts/${p.id}`} class="font-semibold text-blue-600 hover:underline">
              {`#${p.id}: ${p.title}`}
            </Link>
            <p class="mt-1 text-sm text-gray-700">{p.text}</p>
            <p class="mt-1 text-xs text-gray-400">{p.createdAt}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
