// ADR 0060 dogfood: posts toy DB。.server.tsx 経由でしか触らない server-only data。
// .server.tsx → server.ts → data/posts.ts と層を 1 段挟むことで、ADR 0058 の
// 「.server.tsx (component) と server.ts (logic) の責務分離」を dogfood する。
//
// in-memory store。Cloudflare Workers の isolate 寿命依存だが、partial hydration の
// bundle 削減効果実測には十分。実プロジェクトでは KV / D1 などに差し替え。

export type Post = {
  id: number;
  title: string;
  text: string;
  createdAt: string; // ISO 8601 文字列 (Date instance ではない = JSON serialize 通る)
};

const posts: Post[] = [
  {
    id: 1,
    title: "Vidro RSC-like の核心は invoke-once",
    text: "React RSC が Flight payload で server / client tree を結合するのに対し、Vidro は両側 invoke-once + signal で Flight を不要にする。シンプルさの構造的根拠。",
    createdAt: "2026-04-15T09:30:00Z",
  },
  {
    id: 2,
    title: ".server.tsx は拡張子で boundary",
    text: "directive (use client / use server) ではなく拡張子で server-only を表現。AI 親和 + import chain 追跡不要 + 後付けで .tsx → .server.tsx rename だけで bundle 除外できる。",
    createdAt: "2026-04-22T14:10:00Z",
  },
  {
    id: 3,
    title: "Partial hydration: stub + marker + island walker",
    text: "ADR 0060 で着地。.server.tsx を client bundle で stub virtual module 化 + 内部 .tsx import を island として hydrate。Astro / SolidStart 系譜の標準アプローチで自己流ロックインなし。",
    createdAt: "2026-05-06T13:00:00Z",
  },
];

export function getAllPosts(): Post[] {
  return posts;
}

export function getPostById(id: number): Post | null {
  return posts.find((p) => p.id === id) ?? null;
}
