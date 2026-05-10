// dogfood 第 7 周目 (2026-05-10): feature-based 切り分け。
//
// 旧 (第 6 周目): routes 各 dir に schema.ts を散らす (= D 案、近接 co-location)。
// 新 (第 7 周目): posts feature 全体の schema を本 file に集約、routes / island
// 両方が import 共有。同 shape (= title + body) は create/update で 1 個に統合
// (= YAGNI、仕様分岐したら分離)。
//
// scope: write 系 (create / update / delete) のみ。read 系 (postsAsync /
// postBySlug) は data/posts.ts 側で型が決まるので features 化 scope 外。

import { z } from "zod";

/** Post identifier (= URL slug)。update / delete で共有。 */
export const slugParamsSchema = z.object({ slug: z.string().min(1) });

/** 投稿 payload (= title + body)。create / update で同 shape を共有。 */
export const postContentSchema = z.object({
  title: z.string().min(1, "title is required"),
  body: z.string().min(1, "body is required"),
});

export type PostContentInput = z.infer<typeof postContentSchema>;
