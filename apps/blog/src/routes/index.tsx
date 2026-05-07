import { signal } from "@vidro/core";

export default function Home() {
  const count = signal(0);

  return (
    <div class="mx-auto max-w-md p-8">
      <h1 class="text-3xl font-bold">Hello, Vidro!</h1>
      <h3 class="mt-4 text-2xl">{count.value}</h3>
      <button
        type="button"
        class="mt-2 rounded bg-blue-500 px-4 py-2 text-white hover:bg-blue-600"
        onClick={() => count.value++}
      >
        add
      </button>
    </div>
  );
}
