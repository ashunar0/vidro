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

// 最小 action: title を受けて note を 1 件追加するだけ。
// 戻り値は plain object → router が loader 自動 revalidate して
// `{ actionResult, loaderData }` を返す。client は actionResult を submission.value
// に流し、loaderData で page を再 render する。
export async function action({ request }: ActionArgs<"/notes">) {
  const fd = await request.formData();
  const title = getStringField(fd, "title").trim();
  if (!title) throw new Error("title is required");
  const note: Note = { id: nextId++, title };
  notes.push(note);
  return { addedNote: note };
}
