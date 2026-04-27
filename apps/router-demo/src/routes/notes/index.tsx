import { Show } from "@vidro/core";
import { submission, type PageProps } from "@vidro/router";
import type { action, loader } from "./server";

// ADR 0037 Phase 3 R-min の動作確認 demo。
// - form method="post" を Web 標準のまま書く
// - Router が submit を hijack → fetch → `{actionResult, loaderData}` 返却 →
//   submission signal 更新 + bootstrap data 上書き + reset() で loader revalidate
// - JS 切でも form は普通に動く (= server が action 実行 → 同 path にレスポンス)
export default function NotesPage({ data }: PageProps<typeof loader>) {
  const sub = submission<typeof action>();
  return (
    <section>
      <h2>Notes (form action demo / ADR 0037)</h2>
      <p>
        Phase 3 R-min: form を Web 標準のまま <code>method="post"</code> で書くと、 Router が submit
        を hijack して action 経路に流す。
      </p>

      <ul data-testid="notes-list">
        {/* For を使わず array.map で static 展開 (For は B-4 案件で hydrate cursor
            mismatch する pre-existing 宿題)。さらに li 内 children は template
            literal で 1 dynamic にまとめる: SSR の adjacent text merge と
            client の _$text/_$dynamicChild 分割が cursor mismatch するため。
            submit 後の revalidate では Router の swap で component 全体が新規
            mount されるので data.notes 変化は反映される。 */}
        {data.notes.map((n) => (
          <li>{`#${n.id}: ${n.title}`}</li>
        ))}
      </ul>

      <form method="post">
        <input
          name="title"
          data-testid="note-title-input"
          placeholder="Note title"
          style="margin-right: 0.5rem;"
        />
        <button data-testid="note-submit-button">
          {sub.pending.value ? "Adding..." : "Add note"}
        </button>
      </form>

      <Show when={sub.value.value}>
        {/* Vidro Show は accessor pattern ではない (= children に value 渡さない、
            ADR 0025 children getter 化はあるが arg なし)。children 内で signal を
            直接読む形 = reactive に追従する。 */}
        {() => (
          <p data-testid="submission-success" style="color: green;">
            Added:{" "}
            <strong>{`${(sub.value.value as { addedNote: { title: string } } | undefined)?.addedNote.title ?? ""}`}</strong>
          </p>
        )}
      </Show>

      <Show when={sub.error.value}>
        {() => (
          <p data-testid="submission-error" style="color: red;">
            {`Error: ${sub.error.value?.message ?? ""}`}
          </p>
        )}
      </Show>
    </section>
  );
}
