import type { ActionArgs, LoaderArgs } from "@vidro/router";

// in-memory store (toy demo)。Cloudflare Workers の isolate 寿命に依存するが、
// action → loader 自動 revalidate の動作確認には十分。
type Note = { id: number; title: string };

// ADR 0053 dogfood: pagination 体感のため初期 dataset を 12 件用意 (PAGE_SIZE=5
// で 3 page に渡る)。Vidro の design north star は「個人 / hobby / cf scale」なので
// pagination の主目的は「画面に収まる cohesive 表示」であり、巨大データ scale ではない。
let notes: Note[] = [
  { id: 1, title: "Welcome to Vidro" },
  { id: 2, title: "loader と action を dogfood 中" },
  { id: 3, title: "Path Y: searchParams は client URL state" },
  { id: 4, title: "ADR 0053: LoaderArgs に request" },
  { id: 5, title: "fine-grained reactivity vs VDOM" },
  { id: 6, title: "Vidro = Marko wire DNA + Solid primitive DNA" },
  { id: 7, title: "store primitive と signalify" },
  { id: 8, title: "intent pattern で複数 form 区別" },
  { id: 9, title: "derive 派楽観更新で rollback コードゼロ" },
  { id: 10, title: "loaderData() は per-page reactive store" },
  { id: 11, title: "Hono 透明性: Web 標準を素のまま" },
  { id: 12, title: "型貫通は Vidro identity の核" },
];
let nextId = 13;

const PAGE_SIZE = 5;

// ADR 0053: loader が `request: Request` を受ける。`new URL(request.url).searchParams`
// で `?page=` / `?q=` を読み、server-side で filter + paginate する。
//
// pagination dogfood (本 ADR の主目的):
//   - `/notes` (default) → page 1、items 1-5
//   - `/notes?page=2` → items 6-10
//   - `/notes?q=Vidro&page=1` → "Vidro" を含む notes の 1 page 目
//
// page / q が変わったら client 側 effect(() => { sp.page.value; sp.q.value; revalidate(); })
// が loader を再 fire (= ADR 0052 path Y、URL 自動 fire は **しない**、user が
// explicit に bind する形)。
export async function loader({ request }: LoaderArgs<"/notes">) {
  const url = new URL(request.url);
  const q = url.searchParams.get("q") ?? "";
  const pageRaw = Number(url.searchParams.get("page") ?? "1");
  const filtered = q
    ? notes.filter((n) => n.title.toLowerCase().includes(q.toLowerCase()))
    : notes.slice();
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  // page を [1, totalPages] に clamp (= 範囲外 URL を server で正規化、user の手間減らす)
  const page =
    Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.min(Math.floor(pageRaw), totalPages) : 1;
  const start = (page - 1) * PAGE_SIZE;
  return {
    notes: filtered.slice(start, start + PAGE_SIZE),
    totalPages,
    page,
  };
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
