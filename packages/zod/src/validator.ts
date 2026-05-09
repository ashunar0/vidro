// ADR 0071 + ADR 0072: validator(schema) middleware。
//
// server function 用 input parse middleware。c.var.body (= dispatchServerFn が
// bodyArgs[0] を詰める経路、ADR 0072 論点 5-A) を schema.safeParse で検証して、
// failure なら 422 + {fields} を Response として throw、success なら
// next([parsed.data]) で handler の input 引数を **typed 値** に override する。
//
// 設計:
//   - **input ある fn 専用前提** — bodyArgs.length === 0 の引数なし fn では
//     c.var.body が undefined、schema.safeParse(undefined) で 422 が返る (=
//     user に明示 error で「validator は input ある fn 専用」と気付かせる、
//     ADR 0072 review 60th session)
//   - 422 wire shape は ADR 0059 規約 `{fields: Record<string, string>}`、
//     fieldsFromZodError(err) で flatten
//   - failure 時 throw new Response (= early return 経路)、handler に到達しない
//
// 関連:
//   - ADR 0070: server function pattern
//   - ADR 0071: @vidro/zod opt-in pack 詳細
//   - ADR 0072: handler signature pure service form (= input typed override 経路)
//   - ADR 0059: validation error primitive (= 422 + {fields} wire 規約)

import type { Middleware } from "@vidro/router";
import type { z } from "zod";
import { fieldsFromZodError } from "./fields-from-zod-error";

/**
 * server function に schema を渡して input を parse + typed input を handler に
 * override する middleware factory。
 *
 * @example
 * import { validator } from "@vidro/zod";
 * import { z } from "zod";
 * import { serverFn } from "@vidro/router";
 *
 * const schema = z.object({ title: z.string().min(1) });
 * export const createPost = serverFn(validator(schema), async (input) => {
 *   // input は { title: string } で typed
 *   return db.posts.insert(input);
 * });
 */
export function validator<S extends z.ZodSchema>(schema: S): Middleware<unknown, z.infer<S>> {
  return ((c, next) => {
    const body = c.var.body;
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      const fields = fieldsFromZodError(parsed.error);
      throw new Response(JSON.stringify({ fields }), {
        status: 422,
        headers: { "content-type": "application/json" },
      });
    }
    return next([parsed.data]);
  }) as Middleware<unknown, z.infer<S>>;
}
