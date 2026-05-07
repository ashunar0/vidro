// blog dogfood: posts toy DB。.server.tsx 経由でしか触らない server-only data。
// .server.tsx → server.ts → data/posts.ts と層を 1 段挟むことで、ADR 0058 の
// 「.server.tsx (component) と server.ts (logic) の責務分離」を踏襲する。
//
// in-memory store。Cloudflare Workers の isolate 寿命依存だが、公開側 SSR の
// dogfood には十分。実運用では D1 / KV に差し替え予定。
//
// API 形 (現行):
//   - `db.posts`: 既存 sync immutable view (publishedAt desc sort + freeze 済)
//   - `db.postBySlug(slug)`: 既存 sync lookup
//   - `db.postsAsync()`: ADR 0066 dogfood 用、async API simulator (Promise.resolve)
//
// async 版を入れた経緯: ADR 0066 (async server component native) で
// `.server.tsx` 内 `async function Component() { const x = await db.findAll(); ... }`
// 直書きを実現したので、その動作確認用に async API を 1 個生やしている。実運用で
// D1 / KV に置換した時は db.posts (sync 版) を deprecate して全体を async 化する
// 想定。posts/index.server.tsx は既に await db.postsAsync() を直書きで使って動いている。

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
  // ADR 0066 dogfood 用 async simulator。実運用 D1 query 化の代用。Promise.resolve で
  // 即座に解決する形 (= microtask 1 回挟まる) でも `.server.tsx` 側 `await` を経由する
  // ので async function component 経路の動作確認になる。
  postsAsync: async (): Promise<readonly Post[]> => sorted,
};
