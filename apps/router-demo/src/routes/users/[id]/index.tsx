import type { PageProps } from "@vidro/router";
import type { loader } from "./server";

export default function UserPage({ data, params }: PageProps<typeof loader>) {
  return (
    <section>
      <h2>User</h2>
      <p>
        Path param ID: <strong>{params.id}</strong>
      </p>
      <p>
        Name: <strong>{data.user.name}</strong>
      </p>
      <p>
        Email: <strong>{data.user.email}</strong>
      </p>
      <p>
        (loader が <code>./server.ts</code> から fetch したのだ。
        <code>typeof loader</code> 経由で型貫通)
      </p>
    </section>
  );
}
