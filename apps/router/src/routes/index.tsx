import { signal } from "@vidro/core";
import { navigate } from "@vidro/router";

export default function Home() {
  const count = signal(0);

  return (
    <div>
      <h2 class="text-xl font-semibold">Hello, Vidro!</h2>
      <h3 class="mt-4 text-2xl">{count.value}</h3>
      {/* ADR 0055 dogfood: text + dynamic + text の混在 boundary が hydrate clean か */}
      <p class="mt-2 text-sm text-gray-600">残り {count.value} 秒なのだ</p>
      {/* dynamic + " " + dynamic (= 単一空白 JSXText を boundary に含める検証) */}
      <p class="mt-1 text-sm text-gray-600">
        {count.value} : {count.value * 2}
      </p>
      <div class="mt-2 flex gap-2">
        <button
          type="button"
          class="rounded bg-blue-500 px-4 py-2 text-white hover:bg-blue-600"
          onClick={() => count.value++}
        >
          add
        </button>
        <button
          type="button"
          class="rounded bg-green-500 px-4 py-2 text-white hover:bg-green-600"
          onClick={() => navigate(`/users/${count.value}`)}
        >
          Go to User #{count.value}
        </button>
      </div>
    </div>
  );
}
