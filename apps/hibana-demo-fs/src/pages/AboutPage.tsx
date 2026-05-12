// /about の page (filesystem-based 版、純粋 UI component)。
//
// 解 a (= 第 21 周目) 規約: metadata は **route file (= routes/about/index.tsx) 側** で
// 書く。ここでは pure な UI のみ。

export function AboutPage() {
  return (
    <article>
      <h1>About Hibana (fs)</h1>
      <p>Hono の上に薄く乗る backend-first FW を作ってるのだ (filesystem-based 版)。</p>
      <p>このページは AboutLayout が適用されている (= PostsLayout は出ない想定)。</p>
    </article>
  );
}
