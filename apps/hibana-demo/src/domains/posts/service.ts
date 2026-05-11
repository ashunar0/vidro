import type { Post } from "./schema";

const posts: Post[] = [
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

export const getPosts = () => {
  return posts;
};
