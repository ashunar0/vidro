import { resource, Suspense } from "@vidro/core";

// ADR 0033 out-of-order full streaming の実機検証用 route。
// Suspense を 2 つ並べる:
//   - vb0 (slow): 800ms 遅延後に resolve
//   - vb1 (fast): 即時 resolve
//
// 旧 (ADR 0031 shell+tail) なら全 resource resolve を待ってから boundary を
// 連続 emit するので vb0 → vb1 の順 (= shell の出現順) で flush される。
// 新 (ADR 0033) では各 boundary が独立に resolve → flush するので vb1 (fast)
// が vb0 (slow) より先に descend する。Network panel または DOM 出現タイミング
// で確認できる。
//
// 確認方法 (Playwright / 手動):
//   1. /streaming-demo に navigate
//   2. shell flush で「slow loading...」「fast loading...」が両方見える
//   3. ~100ms で fast セクションが本文に切り替わる
//   4. ~800ms 後に slow セクションが本文に切り替わる
export default function StreamingDemoPage() {
  return (
    <section>
      <h2>Out-of-order Streaming Demo</h2>
      <p>
        Suspense 2 つを並列に配置。<strong>fast</strong> は即時 resolve、
        <strong>slow</strong> は 800ms 遅延。ADR 0033 の out-of-order streaming では fast が先に
        descend する。
      </p>

      <h3>Slow boundary (~800ms)</h3>
      <Suspense fallback={() => <p data-testid="slow-fallback">slow loading...</p>}>
        {() => <SlowBlock />}
      </Suspense>

      <h3>Fast boundary (~100ms)</h3>
      <Suspense fallback={() => <p data-testid="fast-fallback">fast loading...</p>}>
        {() => <FastBlock />}
      </Suspense>
    </section>
  );
}

function SlowBlock() {
  // setTimeout は Cloudflare Workers でも使えるが、env によっては setTimeout が
  // 制限される。jsonplaceholder への artificial slow query を avoid して、
  // Promise + setTimeout で local に遅延させる。
  const data = resource(
    () =>
      new Promise<string>((res) => {
        setTimeout(() => res("slow-resolved"), 800);
      }),
    { bootstrapKey: "streaming-demo:slow" },
  );
  return (
    <p data-testid="slow-content">
      Slow result: <strong>{data.value ?? "..."}</strong>
    </p>
  );
}

function FastBlock() {
  const data = resource(
    () =>
      new Promise<string>((res) => {
        setTimeout(() => res("fast-resolved"), 100);
      }),
    { bootstrapKey: "streaming-demo:fast" },
  );
  return (
    <p data-testid="fast-content">
      Fast result: <strong>{data.value ?? "..."}</strong>
    </p>
  );
}
