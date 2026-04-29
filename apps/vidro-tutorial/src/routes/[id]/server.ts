import type { LoaderArgs } from "@vidro/router";
import { posts } from "../../data/posts";

// LoaderArgs<"/:id"> は plugin 生成の RouteMap から params: { id: string } を引く。
// `[id]` ディレクトリ規約から `/:id` という route path が自動推論される。
export async function loader({ params }: LoaderArgs<"/:id">) {
  // params.id は URL 文字列なので必ず string。Number() で数値化する。
  const id = Number(params.id);
  const post = posts.find((p) => p.id === id);
  return { post: post ?? null };
}
