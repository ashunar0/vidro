import { type PageProps } from "@vidro/router";
import type { loader } from "./server";

export default function User({ params, data }: PageProps<typeof loader>) {
  return (
    <div>
      <h2 class="text-xl font-semibold">User #{params.id}</h2>
      <dl class="mt-4 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2">
        <dt class="text-gray-500">Name</dt>
        <dd class="font-semibold">{data.name}</dd>
        <dt class="text-gray-500">Email</dt>
        <dd>{data.email}</dd>
      </dl>
    </div>
  );
}
