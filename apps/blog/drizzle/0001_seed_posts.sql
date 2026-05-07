-- ADR 0066 dogfood: 旧 in-memory store (apps/blog/src/data/posts.ts の sorted: readonly Post[])
-- に入れていた 3 件を D1 (SQLite) に seed する。drizzle-kit generate --custom で
-- empty migration を作って手書き SQL で insert する流儀。

INSERT INTO posts (slug, title, body, published_at) VALUES
  (
    'why-vidro',
    'Vidro を作り始めた理由',
    'AI 時代のフロントエンド FW として、React RSC の考え方を simpler に置き直したかった。directive ではなく拡張子で server/client を分け、fine-grained reactivity と SSR を両立させる。',
    '2026-04-15T09:30:00Z'
  ),
  (
    'server-tsx-boundary',
    '.server.tsx は拡張子で boundary',
    'directive (use client / use server) ではなく拡張子で server-only を表現。AI 親和 + import chain 追跡不要 + 後付けで .tsx → .server.tsx rename だけで bundle 除外できる。',
    '2026-04-22T14:10:00Z'
  ),
  (
    'fine-grained-and-ssr',
    'fine-grained reactivity と SSR の融合',
    'Solid 系の signal を Vidro でも採用しつつ、HTML-first の wire を default にする。両側 invoke-once + island hydrate で Flight 不要、シンプルさを保つ。',
    '2026-05-06T13:00:00Z'
  );
