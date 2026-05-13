import type { Post, PostInput } from "./schema.ts";

// in-memory mutable store。dogfood 用 = Vite dev server HMR で reset される (= persistence は Step 6 で DB 経由に置換予定)。
// CRUD パターンの dogfood で「Hibana の form / validation / redirect が server-only でどこまで自然に書けるか」を検証する材料。
let posts: Post[] = [
  {
    id: "1",
    title: "Hibana が動き出したのだ",
    excerpt: "Hono + @vidro/core の最初の縦串",
  },
  {
    id: "2",
    title: "Backend-first FW の動機",
    excerpt: "frontend には組織の正解が無い",
  },
  {
    id: "3",
    title: "domain folder 哲学",
    excerpt: "route は handler 登録、UI は domain で組織",
  },
];
let nextId = 4;

export const getPosts = (): Post[] => posts;

export const getPost = (id: string): Post | undefined => posts.find((p) => p.id === id);

export const createPost = (input: PostInput): Post => {
  const post: Post = { id: String(nextId++), ...input };
  posts = [...posts, post];
  return post;
};

export const updatePost = (id: string, input: PostInput): Post | undefined => {
  const idx = posts.findIndex((p) => p.id === id);
  if (idx === -1) return undefined;
  const updated: Post = { ...posts[idx], ...input };
  posts = [...posts.slice(0, idx), updated, ...posts.slice(idx + 1)];
  return updated;
};

export const deletePost = (id: string): boolean => {
  const before = posts.length;
  posts = posts.filter((p) => p.id !== id);
  return posts.length < before;
};
