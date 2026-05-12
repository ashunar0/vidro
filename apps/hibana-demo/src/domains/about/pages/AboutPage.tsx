// /about の page。Step 5 (ADR 0080) dogfood 用に「PostsLayout と別 layout」を持つ page を
// 追加して、`/posts → /about` の layout 切り替え navigation を観察する。

import type { Metadata } from "@vidro/hibana";

export const metadata: Metadata = {
  title: "About — Hibana Demo",
  description: "About page で layout 切り替え navigation を試す",
};

export default function AboutPage() {
  return (
    <article>
      <h1>About Hibana</h1>
      <p>Hono の上に薄く乗る backend-first FW を作ってるのだ。</p>
      <p>このページは AboutLayout が適用されている (= PostsLayout は出ない想定)。</p>
    </article>
  );
}
