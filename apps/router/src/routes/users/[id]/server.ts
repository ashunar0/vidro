import type { LoaderArgs } from "@vidro/router";

// /users/:id の loader。LoaderArgs<"/users/:id"> は plugin 生成の RouteMap から
// params: { id: string } を引いてくる (ADR 0011 + 0012)。
export async function loader({ params }: LoaderArgs<"/users/:id">) {
  const res = await fetch(`https://jsonplaceholder.typicode.com/users/${params.id}`);
  if (!res.ok) throw new Error(`Failed to fetch user ${params.id}: ${res.status}`);
  return (await res.json()) as { id: number; name: string; email: string };
}
