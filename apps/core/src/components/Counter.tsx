import { signal } from "@vidro/core";

export function Counter() {
  const count = signal(0);

  return (
    <div class="mx-auto max-w-md p-8 font-sans">
      <h1 class="mb-6 text-2xl font-bold">Counter</h1>
      <p class="mb-3 text-4xl">{count.value}</p>
      <div class="flex gap-2">
        <button
          type="button"
          class="rounded px-4 py-2 bg-black text-white"
          onClick={() => count.value++}
        >
          +
        </button>
        <button type="button" class="rounded px-4 py-2 border" onClick={() => count.value--}>
          -
        </button>
        <button type="button" class="rounded px-4 py-2 border" onClick={() => (count.value = 0)}>
          reset
        </button>
      </div>
    </div>
  );
}
