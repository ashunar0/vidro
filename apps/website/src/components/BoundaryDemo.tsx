import { Signal, ErrorBoundary, effect } from "@vidro/core";
import { Button } from "./Button";

// 子コンポーネント: count が 3 以上になると Effect 内で throw する。
// boundary の catch 対象としては「子 Effect の再実行時 throw (B パターン)」に該当。
function Risky() {
  const count = new Signal(0);

  effect(() => {
    if (count.value >= 3) throw new Error(`count reached ${count.value}`);
  });

  return (
    <div class="flex flex-col items-center gap-3">
      <p class="text-4xl font-semibold tabular-nums">{count.value}</p>
      <Button variant="icon" onClick={() => count.value++}>
        +
      </Button>
      <p class="text-xs text-neutral-500 dark:text-neutral-400">3 以上で throw するのだ</p>
    </div>
  );
}

export function BoundaryDemo() {
  return (
    <section class="text-center">
      <h2 class="text-2xl font-semibold mb-2 tracking-tight">error boundary</h2>
      <p class="text-sm text-neutral-500 dark:text-neutral-400 mb-6">
        子 Effect の throw を境界が捕まえ、fallback に差し替える。reset で再 mount。
      </p>
      <ErrorBoundary
        onError={(err: unknown) => {
          // eslint-disable-next-line no-console
          console.error("[BoundaryDemo]", err);
        }}
        fallback={(err: unknown, reset: () => void) => (
          <div class="flex flex-col items-center gap-3 px-4 py-6 border border-red-400 dark:border-red-500 rounded-lg">
            <p class="text-red-600 dark:text-red-400 font-semibold">
              caught: {(err as Error).message}
            </p>
            <Button variant="muted" onClick={reset}>
              reset (再 mount)
            </Button>
          </div>
        )}
      >
        {() => <Risky />}
      </ErrorBoundary>
    </section>
  );
}
