// @vitest-environment node
// ADR 0065 Phase 5: scope context が `await` を生き残ることを assert する test。
//
// 旧 try/finally push/pop 実装では `runWithXxxScope(fn)` 内側で `await` した直後に
// scope が null になっていたが (= finally pop が microtask より先に走るため)、
// scope-context.ts の AsyncLocalStorage migration によって context が async 子孫に
// 伝播するように直っている。
//
// browser fallback (= ALS なし) では preservation が効かないが、test 環境
// (Node.js) では ALS が動くので preservation を assert できる。

import { describe, expect, test } from "vite-plus/test";
import { runWithIslandScope, getIslandSeqState } from "../src/island-scope";
import {
  ResourceScope,
  runWithResourceScope,
  getCurrentResourceScope,
} from "../src/resource-scope";
import { SuspenseScope, runWithSuspenseScope, getCurrentSuspense } from "../src/suspense-scope";
import { StreamingContext, runWithStream, getCurrentStream } from "../src/streaming-scope";

describe("scope context survival across await (ADR 0065)", () => {
  test("islandScope: await 後も同じ Map が引ける", async () => {
    let inside: Map<string, number> | null = null;
    let afterAwait: Map<string, number> | null = null;

    const result = await runWithIslandScope(async () => {
      inside = getIslandSeqState();
      // microtask boundary
      await Promise.resolve();
      afterAwait = getIslandSeqState();
      return "done";
    });

    expect(result).toBe("done");
    expect(inside).not.toBe(null);
    expect(afterAwait).toBe(inside); // ← 同一 instance 維持
  });

  test("resourceScope: await 後も同じ scope が引ける", async () => {
    const scope = new ResourceScope();
    let inside: ResourceScope | null = null;
    let afterAwait: ResourceScope | null = null;

    await runWithResourceScope(scope, async () => {
      inside = getCurrentResourceScope();
      await Promise.resolve();
      afterAwait = getCurrentResourceScope();
    });

    expect(inside).toBe(scope);
    expect(afterAwait).toBe(scope);
  });

  test("suspenseScope: await 後も同じ scope が引ける", async () => {
    const scope = new SuspenseScope();
    let inside: SuspenseScope | null = null;
    let afterAwait: SuspenseScope | null = null;

    await runWithSuspenseScope(scope, async () => {
      inside = getCurrentSuspense();
      await Promise.resolve();
      afterAwait = getCurrentSuspense();
    });

    expect(inside).toBe(scope);
    expect(afterAwait).toBe(scope);
  });

  test("streamingScope: await 後も同じ context が引ける", async () => {
    const ctx = new StreamingContext();
    let inside: StreamingContext | null = null;
    let afterAwait: StreamingContext | null = null;

    await runWithStream(ctx, async () => {
      inside = getCurrentStream();
      await Promise.resolve();
      afterAwait = getCurrentStream();
    });

    expect(inside).toBe(ctx);
    expect(afterAwait).toBe(ctx);
  });

  test("nested scope: 内側 scope が外側を遮蔽、抜けたら外側に戻る (await を含む)", async () => {
    const outer = new ResourceScope();
    const inner = new ResourceScope();
    const trace: (ResourceScope | null)[] = [];

    await runWithResourceScope(outer, async () => {
      trace.push(getCurrentResourceScope()); // outer
      await Promise.resolve();
      trace.push(getCurrentResourceScope()); // outer (await 越し維持)
      await runWithResourceScope(inner, async () => {
        trace.push(getCurrentResourceScope()); // inner
        await Promise.resolve();
        trace.push(getCurrentResourceScope()); // inner (await 越し維持)
      });
      trace.push(getCurrentResourceScope()); // outer (inner 抜け後)
    });

    expect(trace).toEqual([outer, outer, inner, inner, outer]);
  });

  test("並行 scope: Promise.all で複数 scope が混ざらない (= isolate-per-request 安全性)", async () => {
    const a = new ResourceScope();
    const b = new ResourceScope();
    const traceA: (ResourceScope | null)[] = [];
    const traceB: (ResourceScope | null)[] = [];

    await Promise.all([
      runWithResourceScope(a, async () => {
        traceA.push(getCurrentResourceScope());
        await new Promise((r) => setTimeout(r, 5));
        traceA.push(getCurrentResourceScope());
      }),
      runWithResourceScope(b, async () => {
        traceB.push(getCurrentResourceScope());
        await new Promise((r) => setTimeout(r, 5));
        traceB.push(getCurrentResourceScope());
      }),
    ]);

    // 各 task は自分の scope を一貫して引く、混ざらない
    expect(traceA).toEqual([a, a]);
    expect(traceB).toEqual([b, b]);
  });

  test("scope 外: getCurrent() は null", () => {
    expect(getIslandSeqState()).toBe(null);
    expect(getCurrentResourceScope()).toBe(null);
    expect(getCurrentSuspense()).toBe(null);
    expect(getCurrentStream()).toBe(null);
  });

  test("sync passthrough: runWith が sync 関数の return 値を直接返す", () => {
    const result = runWithIslandScope(() => {
      return 42;
    });
    expect(result).toBe(42);
  });
});
