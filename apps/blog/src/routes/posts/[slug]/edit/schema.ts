// dogfood 第 6 周目 (2026-05-10): schema 重複解消。
//
// edit dir では paramsSchema (URL slug) + dataSchema (form payload) の 2 種類。
// dir 内の中立 file (schema.ts) に集約し、server.ts と edit-form.tsx 両方から import。
//
// new/schema.ts の dataSchema と shape が同じ (title + body) だが、共有しない:
// 用途が分岐 (= create vs update) する可能性があるので各 dir で独立進化させる。

import { z } from "zod";

export const paramsSchema = z.object({ slug: z.string().min(1) });

export const dataSchema = z.object({
  title: z.string().min(1, "title is required"),
  body: z.string().min(1, "body is required"),
});

export type UpdatePostInput = z.infer<typeof dataSchema>;
