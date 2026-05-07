// blog dogfood: posts toy DB。.server.tsx 経由でしか触らない server-only data。
// .server.tsx → server.ts → data/posts.ts と層を 1 段挟むことで、ADR 0058 の
// 「.server.tsx (component) と server.ts (logic) の責務分離」を踏襲する。
//
// in-memory store。Cloudflare Workers の isolate 寿命依存だが、公開側 SSR の
// dogfood には十分。実運用では D1 / KV に差し替え予定。
//
// API 形は `db.posts` / `db.postBySlug(slug)` の namespace + property access。
// `db.posts` は publishedAt desc に sort + freeze 済の immutable view を返す
// (= 呼び出し側は sort 知識を持たない)。
//
// 注: 本物の D1 / KV / Postgres にした時は `db.posts(): Promise<Post[]>` /
// `db.postBySlug(slug): Promise<Post|null>` の async API に変わる。その時は
// `.server.tsx` の async component サポート (= core h() の sync 呼び出し制約解消)
// が必要。memory `project_pending_rewrites` 参照、優先度: 高。

export type Post = {
  slug: string;
  title: string;
  body: string;
  publishedAt: string; // ISO 8601 文字列 (Date instance ではない = JSON serialize 通る)
};

const seed: Post[] = [
  {
    slug: "why-vidro",
    title: "Vidro を作り始めた理由",
    body: "AI 時代のフロントエンド FW として、React RSC の考え方を simpler に置き直したかった。directive ではなく拡張子で server/client を分け、fine-grained reactivity と SSR を両立させる。",
    publishedAt: "2026-04-15T09:30:00Z",
  },
  {
    slug: "server-tsx-boundary",
    title: ".server.tsx は拡張子で boundary",
    body: "directive (use client / use server) ではなく拡張子で server-only を表現。AI 親和 + import chain 追跡不要 + 後付けで .tsx → .server.tsx rename だけで bundle 除外できる。",
    publishedAt: "2026-04-22T14:10:00Z",
  },
  {
    slug: "fine-grained-and-ssr",
    title: "fine-grained reactivity と SSR の融合",
    body: "Solid 系の signal を Vidro でも採用しつつ、HTML-first の wire を default にする。両側 invoke-once + island hydrate で Flight 不要、シンプルさを保つ。",
    publishedAt: "2026-05-06T13:00:00Z",
  },
];

// module load 時に 1 回だけ sort + freeze。以降は同じ参照を返す。
const sorted: readonly Post[] = Object.freeze(
  [...seed].sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1)),
);

export const db = {
  posts: sorted,
  postBySlug: (slug: string): Post | null => sorted.find((p) => p.slug === slug) ?? null,
};
