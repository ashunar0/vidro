// 公開側: 全記事一覧 (`.server.tsx`)。
// ADR 0066 dogfood: `async function Component() { const posts = await listPosts(); ... }`
// 直書き形式。core の h() が Promise<Node> を VAsyncSlot に包んで AsyncScope に register、
// renderToReadableStream / renderToStringAsync の allSettled 待ち合わせ後に markup に展開される。
// signal / computed / effect は使えない (= 全部 static HTML として焼かれる、ADR 0058)。
//
// dogfood 第 8 周目 (2026-05-10): db 直叩き → listPosts() serverFn 経由に変更。
// SSR pass では server-boundary plugin が stub に置換しないので in-process 直 invoke、
// HTTP loopback は発生しない (= packages/plugin/src/server-boundary.ts 参照)。
//
// 詳細 page は posts/[slug]/index.server.tsx で別途。

import { Link } from "@vidro/router";
import { listPosts } from "../../features/posts/server";
import { DeleteButton } from "./delete-button";

export default async function PostsIndex() {
  const posts = await listPosts({});

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
              {/* dogfood Path 4 (2026-05-10、61st session): resource route 経路を
                   廃止して row 単位 island に置換 (= ADR 0070 統一)。trade-off:
                   JS なしでは動かない (= form delegation の progressive enhancement
                   失う)、行ごとに island instance、navigate 経由 reload で再描画。 */}
              <DeleteButton slug={p.slug} />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
