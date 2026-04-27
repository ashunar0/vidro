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

// ADR 0038 Phase 3 R-mid-1 の動作確認 action。intent 分岐 (R-mid-2) もここで demo:
// `<input type="hidden" name="intent" value="create|delete">` を読んで分岐する。
// framework 側の改修は不要 (= runtime のみで分岐)。
export async function action({ request }: ActionArgs<"/notes">) {
  const fd = await request.formData();
  const intent = String(fd.get("intent") ?? "");

  if (intent === "create") {
    const title = String(fd.get("title") ?? "").trim();
    if (!title) throw new Error("title is required");
    const note: Note = { id: nextId++, title };
    notes.push(note);
    return { intent: "create" as const, addedNote: note };
  }

  if (intent === "delete") {
    const id = Number(fd.get("id") ?? "");
    if (!Number.isFinite(id)) throw new Error("id is required");
    const idx = notes.findIndex((n) => n.id === id);
    if (idx < 0) throw new Error(`note not found: ${id}`);
    const [removed] = notes.splice(idx, 1);
    return { intent: "delete" as const, removedNote: removed };
  }

  throw new Error(`unknown intent: ${intent}`);
}
