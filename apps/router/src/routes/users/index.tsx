import { For } from "@vidro/core";
import { Link, loaderData, type PageProps } from "@vidro/router";
import type { loader } from "./server";

// ADR 0049: data は loaderData() 経由で reactive 取得。各 user は Store<{...}>
// なので leaf access は `.value`。配列の length 変化 / 要素 field 変化はそれぞれ
// proxy 内部の signal 経由で fine-grained に届く。
export default function Users(_props: PageProps<typeof loader>) {
  const data = loaderData<typeof loader>();
  return (
    <div>
      <h2 class="text-xl font-semibold">Users</h2>
      <ul class="mt-4 space-y-2">
        <For each={data}>
          {(user) => (
            <li class="rounded border">
              <Link href={`/users/${user.id.value}`} class="block px-3 py-2 hover:bg-gray-50">
                <div class="font-semibold">{user.name.value}</div>
                <div class="text-sm text-slate-500">{user.email.value}</div>
              </Link>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}
