// 編集 form page (= GET /posts/[slug]/edit)。
// `.tsx` (sync) + loaderData() で prefill + submission() で fieldError。Remix 原型。

import { Show } from "@vidro/core";
import { loaderData, submission } from "@vidro/router";
import type { action, loader } from "./server";
import type { Route } from "./+types";

export default function EditPost({ params }: Route.PageProps) {
  const data = loaderData<typeof loader>();
  const sub = submission<typeof action>();

  return (
    <section>
      <h2 class="text-xl font-semibold">Edit post</h2>
      <p class="mt-1 text-xs text-gray-500">slug: {params.slug}</p>

      <form method="post" class="mt-4 space-y-4">
        <div>
          <label class="block text-sm font-medium" for="title">
            Title
          </label>
          <input
            id="title"
            name="title"
            type="text"
            value={data.post.title.value}
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
          >
            {data.post.body.value}
          </textarea>
          <Show when={() => sub.fieldError.value?.body}>
            {() => <p class="mt-1 text-sm text-red-600">{sub.fieldError.value?.body}</p>}
          </Show>
        </div>

        <button
          type="submit"
          disabled={sub.pending.value}
          class="rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {() => (sub.pending.value ? "Saving..." : "Save changes")}
        </button>
      </form>
    </section>
  );
}
