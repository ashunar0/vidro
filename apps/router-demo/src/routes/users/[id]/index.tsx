import type { PageProps } from "@vidro/router";

export default function UserPage({ params }: PageProps<{ id: string }>) {
  return (
    <section>
      <h2>User</h2>
      <p>
        User ID: <strong>{params.id}</strong>
      </p>
      <p>
        (dynamic segment <code>/users/[id]</code> にマッチしているのだ)
      </p>
    </section>
  );
}
