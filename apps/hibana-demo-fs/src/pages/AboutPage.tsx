// /about の page (filesystem-based 版、純粋 UI component)。
//
// 解 a (= 第 21 周目) 規約: metadata は **route file (= routes/about/index.tsx) 側** で
// 書く。ここでは pure な UI のみ。
//
// page-local island dogfood: article 内の Counter は AboutPage と一緒に <Frame> の中で
// render される。`/posts → /about` の navigate で innerHTML 入れ替えにより出現するが、
// 現状 partial HTML 内 `<script>` は実行されないため click 無反応 (= hydrate なし、
// [[project_adr_0080_status]] 既知 limitation)。

import Counter from "../domains/posts/components/Counter.island";

export function AboutPage() {
  return (
    <article>
      <h1>About Hibana (fs)</h1>
      <p>Hono の上に薄く乗る backend-first FW を作ってるのだ (filesystem-based 版)。</p>
      <p>このページは AboutLayout が適用されている (= PostsLayout は出ない想定)。</p>
      <p style="margin-top: 24px; padding: 12px; background: #fffbea; border: 1px solid #f6d870;">
        <small>Page-local (= navigate で出現するが hydrate なし、click 無反応):</small>{" "}
        <Counter initial={100} />
      </p>
    </article>
  );
}
