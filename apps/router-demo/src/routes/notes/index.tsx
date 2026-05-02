import { computed, Show } from "@vidro/core";
import { loaderData, submissions } from "@vidro/router";
import type { action, loader } from "./server";

// ADR 0051 derive 派楽観更新 demo。
// - `submissions<typeof action>()` で route 全 in-flight を array で取り、intent で filter
// - 楽観行は subs.value から derive (canonical store には書き込まない)
// - 各 form は HTML `<button name="intent" value="...">` で区別
// - 連打で複数 in-flight 自然対応
// - success / error は最新の create / delete を fish-out して表示
export default function NotesPage() {
  const data = loaderData<typeof loader>();
  const subs = submissions<typeof action>();

  // intent ごとの最新 submission (= success / error 表示の素材)。
  // auto-cleanup で success は revalidate 完了後に消えるが、completed-but-not-yet-cleaned-up
  // 期間 (= action 終了 ~ loader revalidate 完了) は array に居るので一瞬だけ捕捉できる。
  const lastCreate = computed(() => {
    const list = subs.value.filter((s) => s.input.value?.intent === "create");
    return list[list.length - 1];
  });
  const lastDelete = computed(() => {
    const list = subs.value.filter((s) => s.input.value?.intent === "delete");
    return list[list.length - 1];
  });

  // 楽観行: pending な create だけを並べる
  const pendingCreates = computed(() =>
    subs.value.filter((s) => s.input.value?.intent === "create" && s.pending.value),
  );

  return (
    <section>
      <h2>Notes (form action demo / ADR 0051)</h2>
      <p>derive 派楽観更新 + intent pattern + 複数 in-flight + auto-cleanup の dogfood。</p>

      <ul data-testid="notes-list">
        {data.notes.map((n) => {
          const isDeleting = computed(() =>
            subs.value.some(
              (s) =>
                s.input.value?.intent === "delete" &&
                s.input.value?.id === String(n.id.value) &&
                s.pending.value,
            ),
          );
          return (
            <li style={isDeleting.value ? "opacity: 0.5; text-decoration: line-through;" : ""}>
              <span>
                #{n.id.value}: {n.title.value}{" "}
              </span>
              <form method="post" style="display: inline;">
                <input type="hidden" name="id" value={String(n.id.value)} />
                <button name="intent" value="delete" data-testid={`delete-${n.id.value}`}>
                  Delete
                </button>
              </form>
            </li>
          );
        })}
        {/* 楽観行: pending な create を仮表示。loader revalidate 完了で auto-cleanup → 自然消滅 */}
        {pendingCreates.value.map((s) => (
          <li style="opacity: 0.5;" data-testid="pending-note">
            (adding) {(s.input.value?.title as string | undefined) ?? ""}
          </li>
        ))}
      </ul>

      <form method="post">
        <input
          name="title"
          data-testid="note-title-input"
          placeholder="Note title"
          style="margin-right: 0.5rem;"
        />
        <button name="intent" value="create" data-testid="note-submit-button">
          Add note
        </button>
      </form>

      <Show
        when={lastCreate.value && !lastCreate.value.pending.value && lastCreate.value.value.value}
      >
        {() => (
          <p data-testid="create-success" style="color: green;">
            Added:{" "}
            {(lastCreate.value?.value.value as { addedNote: { title: string } } | undefined)
              ?.addedNote.title ?? ""}
          </p>
        )}
      </Show>

      <Show when={lastCreate.value?.error.value}>
        {() => (
          <p data-testid="create-error" style="color: red;">
            Create error: {lastCreate.value?.error.value?.message ?? ""}
          </p>
        )}
      </Show>

      <Show
        when={lastDelete.value && !lastDelete.value.pending.value && lastDelete.value.value.value}
      >
        {() => (
          <p data-testid="delete-success" style="color: orange;">
            Deleted:{" "}
            {(lastDelete.value?.value.value as { removedNote: { title: string } } | undefined)
              ?.removedNote.title ?? ""}
          </p>
        )}
      </Show>

      <Show when={lastDelete.value?.error.value}>
        {() => (
          <p data-testid="delete-error" style="color: red;">
            Delete error: {lastDelete.value?.error.value?.message ?? ""}
          </p>
        )}
      </Show>
    </section>
  );
}
