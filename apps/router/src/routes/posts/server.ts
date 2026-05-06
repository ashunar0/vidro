// ADR 0058 + ADR 0060 dogfood — `.server.tsx` (component) と `server.ts` (logic)
// の責務分離。本 server.ts は loader / action は持たず、`.server.tsx` から直 import
// される server-only helper のみを export する。
//
// Vidro の routing system は `server.ts` を loader / action endpoint として認識する
// が、その機能を **使わない** 形で「単に server bundle に乗る module」として置く。
// `.server.tsx` の `await getAllPosts()` 呼び出し用に薄く wrap してるだけ。
//
// data/ は infrastructure 層相当 (= ADR 0057 / project_layer_separation_principle)。
// 本 file は application 層相当 (= server-only logic を整理するための薄い seam)。

export { getAllPosts, getPostById } from "../../data/posts";
export type { Post } from "../../data/posts";
