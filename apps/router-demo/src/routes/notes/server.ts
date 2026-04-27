import type { ActionArgs, LoaderArgs } from "@vidro/router";

// in-memory note store (toy demo)。Cloudflare Workers では isolate 寿命に依存
// するが、action → loader 自動 revalidate の動作確認には十分。production 化時は
// D1 / KV 等に置換する想定 (Phase 5)。
type Note = { id: number; title: string };

let notes: Note[] = [
  { id: 1, title: "Welcome to Vidro" },
  { id: 2, title: "Phase 3 R-min in progress" },
];
let nextId = 3;

export async function loader(_args: LoaderArgs<"/notes">) {
  // 防衛的 copy で外部に mutable reference を渡さない
  return { notes: notes.slice() };
}

// ADR 0037 Phase 3 R-min の動作確認 action。form の `title` field を読んで
// in-memory list に push、戻り値で submission.value に乗せる。`title` 空は
// throw して submission.error に流す経路を確認できる。
export async function action({ request }: ActionArgs<"/notes">) {
  const fd = await request.formData();
  const title = String(fd.get("title") ?? "").trim();
  if (!title) {
    throw new Error("title is required");
  }
  const note: Note = { id: nextId++, title };
  notes.push(note);
  return { ok: true, addedNote: note };
}
