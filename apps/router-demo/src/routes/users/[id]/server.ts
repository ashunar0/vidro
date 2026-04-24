import type { LoaderArgs } from "@vidro/router";

// 注: 現状は client で実行される (vite plugin での server bundle 分離は後続)。
// 本来は application 層経由で DB アクセス等をやる予定だが、toy runtime 段階では
// public な REST API を fetch して動作確認する。
// LoaderArgs<"/users/:id"> は plugin 生成の RouteMap から params: { id: string }
// を引いてくる (ADR 0011)。
export async function loader({ params }: LoaderArgs<"/users/:id">) {
  const res = await fetch(`https://jsonplaceholder.typicode.com/users/${params.id}`);
  if (!res.ok) throw new Error(`Failed to fetch user ${params.id}: ${res.status}`);
  const user = (await res.json()) as { id: number; name: string; email: string };
  return { user };
}
