import type { LoaderArgs } from "@vidro/router";

// /users の loader。server (CF Worker) で fetch するので client bundle に
// 乗らず、外部 API key 等を秘匿できる (本 demo は public API なので関係ないが)。
// throw された error は router が catch して error.tsx に流す (= user code 側で
// try/catch 不要)。
export async function loader(_args: LoaderArgs) {
  const res = await fetch("https://jsonplaceholder.typicode.com/users");
  if (!res.ok) throw new Error(`Failed to fetch users: ${res.status}`);
  return (await res.json()) as Array<{ id: number; name: string; email: string }>;
}
