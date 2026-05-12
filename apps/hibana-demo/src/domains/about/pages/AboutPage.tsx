// /about の page。Step 5 (ADR 0080) dogfood 用に「PostsLayout と別 layout」を持つ page を
// 追加して、`/posts → /about` の layout 切り替え navigation を観察する。
//
// page-local island dogfood: article 内の Counter は AboutPage と一緒に <Frame> の中で
// render されるので、`/posts → /about` の navigate で innerHTML 入れ替えにより毎回新しく
// 出現する。ただし現状 partial HTML 内の `<script>` は innerHTML 注入では実行されないため、
// **server-render の `<button>Count: 100</button>` は表示されるが click は無反応** (= hydrate
// なし)。これは Step 5 の既知 limitation = [[project_adr_0080_status]] island re-hydrate 未実装。

import type { Metadata } from "@vidro/hibana";
import Counter from "../../posts/components/Counter.island";

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
      <p style="margin-top: 24px; padding: 12px; background: #fffbea; border: 1px solid #f6d870;">
        <small>Page-local (= navigate で出現するが hydrate なし、click 無反応):</small>{" "}
        <Counter initial={100} />
      </p>
    </article>
  );
}
