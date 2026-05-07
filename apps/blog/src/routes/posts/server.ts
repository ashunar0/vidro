// ADR 0058 + 0060 流儀: `.server.tsx` (component) と `server.ts` (logic) の責務分離。
// 本 server.ts は loader / action は持たず、`.server.tsx` から直 import される
// server-only helper のみを re-export する薄い application 層 seam。

export { getAllPosts, getPostBySlug } from "../../data/posts";
export type { Post } from "../../data/posts";
