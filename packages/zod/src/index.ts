// ADR 0073 で `@vidro/zod` の役割を変更:
//
// 旧 (ADR 0071 + ADR 0072): `validator(schema)` middleware を提供、
// `serverFn(validator(schema), handler)` 形で middleware 列に挟む経路。
//
// 新 (ADR 0073): validator middleware は廃止、`@vidro/router` の `serverFn` config
// 内に `validator: { params, data }` slot として直接書く形に統合 (= F1 構造的解決:
// URL 動的 segment と body validator が args 衝突しなくなった)。
//
//   ```ts
//   import { serverFn } from "@vidro/router";
//   import { z } from "zod";
//
//   const paramsSchema = z.object({ slug: z.string() });
//   const dataSchema = z.object({ title: z.string().min(1) });
//
//   export const updatePost = serverFn({
//     validator: { params: paramsSchema, data: dataSchema },
//     handler: async ({ params, data }) => {
//       return db.posts.update(params.slug, data);
//     },
//   });
//   ```
//
// `@vidro/zod` 残務:
//   - `fieldsFromZodError(err)` helper — 422 wire (ADR 0059) の `{ fields }` shape
//     を ZodError から作る。`@vidro/router` の serverFn が validator slot 失敗時に
//     internal で同等処理を走らせるが、user code でも別 path (= 手動 422 構築等) で
//     ZodError → fields 変換が必要な場合があるので helper として残す。
//
// 哲学 (ADR 0057 / ADR 0073):
//   - 薄い core 維持 — `@vidro/router` は zod 不知 (= duck-typed `ValidatorSlot<T>`
//     interface 経由で zod 含む任意 schema を受ける、bundle に zod 強制しない)
//   - 強制ゼロ — zod 採用は user 判断、軽い form は ad-hoc safeParse でも OK
//   - opt-in pack — zod 使う user だけ `@vidro/zod` を入れる、3-tier の +pack tier

export { fieldsFromZodError } from "./fields-from-zod-error";
