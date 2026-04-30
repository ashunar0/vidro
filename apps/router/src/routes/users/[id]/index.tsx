import { loaderData, type PageProps } from "@vidro/router";
import type { loader } from "./server";

// ADR 0049: data は loaderData() 経由。Store<{id,name,email}> なので leaf
// access は `.value`。params は snapshot のまま props 経由で受ける (ADR 0048)。
export default function User({ params }: PageProps<typeof loader>) {
  const data = loaderData<typeof loader>();
  return (
    <div>
      <h2 class="text-xl font-semibold">User #{params.id}</h2>
      <dl class="mt-4 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2">
        <dt class="text-gray-500">Name</dt>
        <dd class="font-semibold">{data.name.value}</dd>
        <dt class="text-gray-500">Email</dt>
        <dd>{data.email.value}</dd>
      </dl>
    </div>
  );
}
