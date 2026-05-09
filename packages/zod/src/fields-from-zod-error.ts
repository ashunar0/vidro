// ADR 0071 + ADR 0059: ZodError → `Record<string, string>` 変換 helper。
//
// validator(schema) middleware の 422 response shape (= ADR 0059 規約) と
// formControl.setFieldErrors の互換 shape を作る。各 field の **最初の error
// message** を取って 1 field 1 message に flatten (= ADR 0059 / ADR 0071 §論点 3
// 同形、複数 message を 1 field に持たせない)。
//
// nested / array path (= `path[0]` が string でない issue) は無視する。flat object
// schema 前提で運用 (= ADR 0071 initial scope)。nested 型貫通強化は future ADR。
//
// 単独 export なので user code でも使える (= 例: server side で別途 ZodError を
// 422 に変換したい場合等)。

import type { z } from "zod";

/**
 * ZodError の issues を flatten して `Record<string, string>` (= ADR 0059 規約) に変換。
 *
 * @example
 * import { fieldsFromZodError } from "@vidro/zod";
 * import { z } from "zod";
 *
 * const schema = z.object({ title: z.string().min(1, "title required") });
 * const result = schema.safeParse({});
 * if (!result.success) {
 *   const fields = fieldsFromZodError(result.error);
 *   // fields = { title: "title required" }
 * }
 */
export function fieldsFromZodError(err: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of err.issues) {
    const path = issue.path[0];
    if (typeof path === "string" && !(path in fields)) {
      fields[path] = issue.message;
    }
  }
  return fields;
}
