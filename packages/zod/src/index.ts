// ADR 0071 + ADR 0072: opt-in zod validator middleware for Vidro server functions。
//
// 哲学:
//   - 薄い core 維持 — @vidro/router / @vidro/core は zod 不知 (= bundle に zod 強制しない)
//   - Hono pattern 踏襲 — @hono/zod-validator と同形 (別 package、middleware 提供)
//   - ADR 0059 規約遵守 — 422 + JSON `{fields: Record<string, string>}` foundation
//   - 強制ゼロ (ADR 0057) — zod 採用は user 判断、軽い form は ad-hoc safeParse でも OK
//
// 使い方:
//
//   import { validator } from "@vidro/zod";
//   import { z } from "zod";
//   import { serverFn } from "@vidro/router";
//
//   const schema = z.object({ title: z.string().min(1) });
//   export const createPost = serverFn(validator(schema), async (input) => {
//     // input は z.infer<typeof schema> で typed
//     return db.posts.insert(input);
//   });
//
// 失敗時は 422 + `{fields: Record<string, string>}` を Response として throw、
// client side stub (= @vidro/router/client の __vidroServerFnStub) が
// ServerFnValidationError として deserialize、user が `try/catch` + `instanceof`
// で field error に流せる。

export { validator } from "./validator";
export { fieldsFromZodError } from "./fields-from-zod-error";
