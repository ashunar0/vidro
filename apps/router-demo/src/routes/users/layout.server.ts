import type { ActionArgs, LoaderArgs } from "@vidro/router";

// /users 配下 layout の loader。Phase 3 第 2 弾 (layout 階層 loader) と
// ADR 0042 (nested action) の動作確認用。
//
// - loader は users 一覧を fetch し、layout 内 badge に出す
// - ADR 0042: layout 自体に action を持てるようになったので、`/users` への POST が
//   leaf に index.tsx + server.ts が居ない場合 (= 本 demo の構成) でも layout の
//   action にフォールバックする経路を demo

// in-memory state: layout action が更新する「最後に mark した時刻」。
let markedAt: string | null = null;

export async function loader(_args: LoaderArgs) {
  const res = await fetch("https://jsonplaceholder.typicode.com/users");
  if (!res.ok) throw new Error(`Failed to fetch users list: ${res.status}`);
  const users = (await res.json()) as Array<{ id: number; name: string }>;
  return { users, markedAt };
}

// ADR 0042: leaf に server.ts が居ないため、`/users` への POST はこの layout
// action にフォールバックして到達する。簡素な demo として markedAt を更新する
// だけ (= 副作用は in-memory)。loader 自動 revalidate で次の render に反映される。
export async function action(_args: ActionArgs<"/users">) {
  markedAt = new Date().toISOString();
  return { ok: true, markedAt };
}
