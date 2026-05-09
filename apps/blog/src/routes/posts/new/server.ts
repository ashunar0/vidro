// dogfood Phase 7' (ADR 0071 + ADR 0072 連動): @vidro/zod validator middleware で
// schema 重複 + safeParse boilerplate + union 戻り値が消えた。
//
// 旧 (Phase 7、ADR 0072 前):
//   const parsed = schema.safeParse(input);
//   if (!parsed.success) {
//     const fields = {}; for (const issue of parsed.error.issues) {...}
//     return { ok: false, fields };
//   }
//   const post = await db.createPost(parsed.data);
//   return { ok: true, slug: post.slug };
//
// 新 (Phase 7'、ADR 0071 + ADR 0072):
//   serverFn(validator(schema), async (input) => {
//     const post = await db.createPost(input);
//     return { slug: post.slug };
//   });
//
// island form (post-form.tsx) は `await createPost(input)` の戻り値が `{ slug }`
// で typed (= 型貫通 #4 完成)、422 は ServerFnValidationError として throw され、
// try/catch + setFieldErrors で field error に流す。

import { serverFn } from "@vidro/router";
import { validator } from "@vidro/zod";
import { z } from "zod";
import { db } from "../../../data/posts";

const inputSchema = z.object({
  title: z.string().min(1, "title is required"),
  body: z.string().min(1, "body is required"),
});

export type CreatePostInput = z.infer<typeof inputSchema>;

// handler の input 型は明示的に annotation する (= validator の Out 型から
// 推論で typed input を渡す経路は serverFn factory に overload を入れる必要が
// あり、ADR 0072 dream code 完全達成は後続 ADR 候補)。現状は schema infer 型
// を annotation で再指定する pragma 形 — ADR 0072 と Hono の `c.req.valid("json")`
// の中間 (= signature に input 型が見える、boilerplate ほぼゼロ)。
export const createPost = serverFn(validator(inputSchema), async (input: CreatePostInput) => {
  const post = await db.createPost(input);
  return { slug: post.slug };
});
