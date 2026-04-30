import type { ActionArgs, LoaderArgs } from "@vidro/router";

// in-memory store (toy demo)。Cloudflare Workers の isolate 寿命に依存するが、
// action → loader 自動 revalidate の動作確認には十分。
type Note = { id: number; title: string };

let notes: Note[] = [
  { id: 1, title: "Welcome to Vidro" },
  { id: 2, title: "loader と action を dogfood 中" },
];
let nextId = 3;

export async function loader(_args: LoaderArgs<"/notes">) {
  return { notes: notes.slice() };
}

// FormData の値を string に narrow (File / null fallback で `[object File]` 混入回避)
function getStringField(fd: FormData, name: string): string {
  const v = fd.get(name);
  return typeof v === "string" ? v : "";
}

// ADR 0051: 1 route = 1 action 規約 + intent pattern。複数 form を `intent` field で
// 識別する (= HTML `<button name="intent" value="...">` 由来、Remix `<Form>` 慣習)。
// 戻り値の type は intent ごとに union だが、`Awaited<ReturnType<action>>` で
// `{ addedNote } | { deletedId } | { error }` として client に貫通する。
export async function action({ request }: ActionArgs<"/notes">) {
  const fd = await request.formData();
  const intent = getStringField(fd, "intent");

  if (intent === "create") {
    const title = getStringField(fd, "title").trim();
    if (!title) throw new Error("title is required");
    const note: Note = { id: nextId++, title };
    notes.push(note);
    return { addedNote: note };
  }

  if (intent === "delete") {
    const idRaw = getStringField(fd, "id");
    const id = Number(idRaw);
    if (!Number.isFinite(id)) throw new Error("invalid id");
    notes = notes.filter((n) => n.id !== id);
    return { deletedId: id };
  }

  throw new Error(`unknown intent: ${intent || "(none)"}`);
}
