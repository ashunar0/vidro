// 執筆 form page (= GET /posts/new)。
// `<form method="post">` で primitive 経路 (= JS なしでも submit 可、ADR 0037 流)。
// JS あり時は Router の form delegation が hijack して `submission()` 経由で
// pending / fieldError を表示する (= ADR 0051 + 0059 + per-route slot)。
//
// 同 path co-location: action は ./server.ts で `Route.ActionArgs` を受ける。

import { Show } from "@vidro/core";
import { submission } from "@vidro/router";
import type { action } from "./server";
import type { Route } from "./+types";

export default function NewPost(_: Route.PageProps) {
  const sub = submission<typeof action>();

  return (
    <section>
      <h2 class="text-xl font-semibold">New post</h2>

      <form method="post" class="mt-4 space-y-4">
        <div>
          <label class="block text-sm font-medium" for="title">
            Title
          </label>
          <input
            id="title"
            name="title"
            type="text"
            class="mt-1 w-full rounded border border-gray-300 px-3 py-2"
          />
          <Show when={() => sub.fieldError.value?.title}>
            {() => <p class="mt-1 text-sm text-red-600">{sub.fieldError.value?.title}</p>}
          </Show>
        </div>

        <div>
          <label class="block text-sm font-medium" for="body">
            Body
          </label>
          <textarea
            id="body"
            name="body"
            rows={6}
            class="mt-1 w-full rounded border border-gray-300 px-3 py-2"
          />
          <Show when={() => sub.fieldError.value?.body}>
            {() => <p class="mt-1 text-sm text-red-600">{sub.fieldError.value?.body}</p>}
          </Show>
        </div>

        <button
          type="submit"
          disabled={sub.pending.value}
          class="rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {() => (sub.pending.value ? "Submitting..." : "Create post")}
        </button>
      </form>
    </section>
  );
}
