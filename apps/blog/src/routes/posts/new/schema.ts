// dogfood 第 6 周目 (2026-05-10): schema 重複解消。
//
// 第 5 周目までは server.ts と post-form.tsx で同じ z.object を 2 度定義していた。
// 第 6 周目で **同 dir 内の中立 file (schema.ts) に切り出し**、server / island 両方
// から import する規約に統一。
//
// 設計判断 (D 案):
//   - server.ts から export しない (= server boundary を曖昧にしない)
//   - serverFn object に schema slot を生やさない (= API 拡張 YAGNI)
//   - dir 内に schema.ts を置く (= co-location 維持、magic ゼロ)

import { z } from "zod";

export const dataSchema = z.object({
  title: z.string().min(1, "title is required"),
  body: z.string().min(1, "body is required"),
});

export type CreatePostInput = z.infer<typeof dataSchema>;
