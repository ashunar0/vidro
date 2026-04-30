import { Show } from "@vidro/core";
import { loaderData, submission, type PageProps } from "@vidro/router";
import type { action, loader } from "./server";

// ADR 0038 Phase 3 R-mid-1 + ADR 0040 Phase 4 step 1 の動作確認 demo。
// - `submission(key)` で per-key state (registry に永続)。
//   loader 自動 revalidate (= component swap) を跨いで result が保持される。
// - 各 form に `{...subX.bind()}` を spread (data-vidro-sub attribute = key)
// - intent 分岐 (R-mid-2) を hidden input + action 内分岐で実現
// - delete button の form は note 行ごとに生やす (per-form state は共通の subDelete)
// - **楽観的 preview** (ADR 0040): submit 中だけ `subCreate.input` から pending 行を
//   仮表示。loader revalidate 完了で本物に置換される自然な UX。
//
// ADR 0049: PageProps.data 廃止 → loaderData<typeof loader>() で reactive store
// を取得。`n.id.value` / `n.title.value` で leaf access (signal triad)。
export default function NotesPage(_props: PageProps<typeof loader>) {
  const data = loaderData<typeof loader>();
  const subCreate = submission<typeof action>("create");
  const subDelete = submission<typeof action>("delete");

  return (
    <section>
      <h2>Notes (form action demo / ADR 0038)</h2>
      <p>
        Phase 3 R-mid-1: <code>submission()</code> per-instance + bind/submit + intent 分岐。
      </p>

      <ul data-testid="notes-list">
        {/* For を使わず array.map で static 展開、`<li>` 内 children は template
            literal で 1 dynamic にまとめる (ADR 0037 と同じ pre-existing 制約)。
            delete form は li 外に置きたいが SSR cursor 整合のため li 内で 1 form
            扱いにし、template literal は別 span にしない (= 同 li 内に dynamic
            が複数並ぶと hydrate mismatch の元になる)。 */}
        {data.notes.map((n) => (
          <li>
            <span>{`#${n.id.value}: ${n.title.value} `}</span>
            <form method="post" {...subDelete.bind()} style="display: inline;">
              <input type="hidden" name="intent" value="delete" />
              <input type="hidden" name="id" value={String(n.id.value)} />
              <button data-testid={`delete-${n.id.value}`}>Delete</button>
            </form>
          </li>
        ))}
        {/* ADR 0040: pending && input の AND ガードで submit 中だけ仮行を出す。
            loader revalidate で本物の note が data.notes に入ったタイミングで
            pending=false に戻る → この li は自然消滅。 */}
        <Show when={subCreate.pending.value && subCreate.input.value}>
          {() => (
            <li style="opacity: 0.5;" data-testid="pending-note">
              {`(adding) ${(subCreate.input.value?.title as string | undefined) ?? ""}`}
            </li>
          )}
        </Show>
      </ul>

      <form method="post" {...subCreate.bind()}>
        <input type="hidden" name="intent" value="create" />
        <input
          name="title"
          data-testid="note-title-input"
          placeholder="Note title"
          style="margin-right: 0.5rem;"
        />
        <button data-testid="note-submit-button">
          {subCreate.pending.value ? "Adding..." : "Add note"}
        </button>
      </form>

      <Show when={subCreate.value.value}>
        {() => (
          <p data-testid="create-success" style="color: green;">
            {`Added: ${(subCreate.value.value as { addedNote: { title: string } } | undefined)?.addedNote.title ?? ""}`}
          </p>
        )}
      </Show>

      <Show when={subCreate.error.value}>
        {() => (
          <p data-testid="create-error" style="color: red;">
            {`Create error: ${subCreate.error.value?.message ?? ""}`}
          </p>
        )}
      </Show>

      <Show when={subDelete.value.value}>
        {() => (
          <p data-testid="delete-success" style="color: orange;">
            {`Deleted: ${(subDelete.value.value as { removedNote: { title: string } } | undefined)?.removedNote.title ?? ""}`}
          </p>
        )}
      </Show>

      <Show when={subDelete.error.value}>
        {() => (
          <p data-testid="delete-error" style="color: red;">
            {`Delete error: ${subDelete.error.value?.message ?? ""}`}
          </p>
        )}
      </Show>
    </section>
  );
}
