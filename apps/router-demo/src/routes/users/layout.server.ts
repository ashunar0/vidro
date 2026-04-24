import type { LoaderArgs } from "@vidro/router";

// /users 配下の layout 用 loader。Phase 3 第 2 弾 (layout 階層 loader) の動作確認用。
// users/[id] の loader と 並列 で fetch されることを Network タブで観察できる想定。
export async function loader(_args: LoaderArgs) {
  const res = await fetch("https://jsonplaceholder.typicode.com/users");
  if (!res.ok) throw new Error(`Failed to fetch users list: ${res.status}`);
  const users = (await res.json()) as Array<{ id: number; name: string }>;
  return { users };
}
