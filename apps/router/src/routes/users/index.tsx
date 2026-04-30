import { For } from "@vidro/core";
import { Link, type PageProps } from "@vidro/router";
import type { loader } from "./server";

export default function Users({ data }: PageProps<typeof loader>) {
  return (
    <div>
      <h2 class="text-xl font-semibold">Users</h2>
      <ul class="mt-4 space-y-2">
        <For each={data}>
          {(user) => (
            <li class="rounded border">
              <Link href={`/users/${user.id}`} class="block px-3 py-2 hover:bg-gray-50">
                <div class="font-semibold">{user.name}</div>
                <div class="text-sm text-slate-500">{user.email}</div>
              </Link>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}
