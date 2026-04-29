import { posts, type Post } from "../../data/posts";

// action は form の POST を server で受け取る関数。
// 戻り値が Response なら framework はそのまま返す = redirect 等の HTTP 操作が直接書ける。
export async function action({ request }: { request: Request }) {
  const fd = await request.formData();
  const title = String(fd.get("title") ?? "");
  const body = String(fd.get("body") ?? "");

  const newPost: Post = {
    id: posts.length + 1,
    title,
    body,
  };
  posts.push(newPost);

  // PRG (Post-Redirect-Get) パターン: 投稿完了後、一覧に redirect。
  // 303 See Other は「POST 完了後に GET で別 page を見せる」用の status code。
  return Response.redirect(new URL("/", request.url), 303);
}
