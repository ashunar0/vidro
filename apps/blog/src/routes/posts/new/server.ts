// dogfood 第 5 周目 (2026-05-10、ADR 0073): createPost を object slot syntax に migration。
// dogfood 第 6 周目 (2026-05-10): schema を ./schema.ts に集約、island と共有。
//
// 旧 (Phase 7'、ADR 0071 + ADR 0072):
//   serverFn(validator(schema), async (input) => { ... })
//
// 新 (ADR 0073、流派 1 object slot):
//   serverFn({ validator: { data: schema }, handler: async ({ data }) => { ... } })
//
// 構造的変化:
//   - validator middleware の `validator(schema)` が **廃止**、`@vidro/router` の
//     serverFn config の validator slot に統合 (= F1 構造解決の副産物)
//   - handler 引数が positional `(input)` → object slot `({ data })`、c は完全排除
//   - `@vidro/zod` import は削除、zod 自体は schema 定義で残る
//   - 第 6 周目で schema は ./schema.ts に切り出し、post-form.tsx と共有 (= D 案)
//
// island form (post-form.tsx) は `await createPost({ data })` で呼ぶ、戻り値
// `{ slug }` typed (= 型貫通 #4 + ADR 0073)、422 は ServerFnValidationError として
// throw され、try/catch + setFieldErrors で field error に流す経路は不変。

import { serverFn } from "@vidro/router";
import { db } from "../../../data/posts";
import { dataSchema } from "./schema";

export type { CreatePostInput } from "./schema";

export const createPost = serverFn({
  validator: { data: dataSchema },
  handler: async ({ data }) => {
    const post = await db.createPost(data);
    return { slug: post.slug };
  },
});
