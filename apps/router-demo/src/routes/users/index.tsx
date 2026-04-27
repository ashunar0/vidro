import { Show } from "@vidro/core";
import { Link, submission } from "@vidro/router";
import type { action } from "./layout.server";

// ADR 0042 demo: leaf に server.ts が無い `/users` path で、layout.server.ts の
// action にフォールバックする経路を確認する。`<form action="/users">` で POST を
// `/users` に向け、layout action (= mark all) を呼ぶ。
export default function Users() {
  const sub = submission<typeof action>("users-mark");

  return (
    <section>
      <h2>Users</h2>
      <p>Pick a user:</p>
      <ul>
        <li>
          <Link href="/users/1">User 1</Link>
        </li>
        <li>
          <Link href="/users/5">User 5</Link>
        </li>
      </ul>

      <form method="post" action="/users" {...sub.bind()}>
        <button data-testid="mark-all-button">
          {sub.pending.value ? "Marking..." : "Mark all (layout action)"}
        </button>
      </form>

      <Show when={sub.value.value}>
        {() => (
          <p data-testid="mark-success" style="color: green;">
            {`OK: marked at ${(sub.value.value as { markedAt: string } | undefined)?.markedAt ?? ""}`}
          </p>
        )}
      </Show>
    </section>
  );
}
