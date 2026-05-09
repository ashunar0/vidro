// dogfood Phase 7 (Phase 2c 実証): AppRouter mode の service 層。
//
// 旧: index.server.tsx の `action` named export (= ADR 0068 同 path co-location、
//     POST /posts/new で受ける)
// 新: 本 server.ts に `createPost = serverFn(...)` を named export、bundler が
//     POST /posts/new/createPost に dispatch する table を auto-gen
//     (= .vidro/server-fn-manifest.ts、ADR 0070 Phase 2c)
//
// island form (post-form.tsx) は `import { createPost } from "./server"` で
// stub 化された fetch を呼ぶ → server side で本 file の handler が走る。
// 同 schema 定義は post-form.tsx 側にも残る (= dogfood で痛み点として観察、
// Phase 6 `@vidro/zod` validator middleware 起票材料)。

import { z } from "zod";
import { serverFn } from "@vidro/router";
import { db } from "../../../data/posts";

const inputSchema = z.object({
  title: z.string().min(1, "title is required"),
  body: z.string().min(1, "body is required"),
});

// validation 失敗を例外でなく union 結果で表現する。Phase 2c の `__vidroServerFnStub`
// は `!res.ok` で plain Error を throw する設計のため、構造化 error (= field 別
// メッセージ) を island で受けたければ普通の戻り値で返すのが今の素直な経路。
// 将来 Phase 6 で `validator(schema)` middleware が 422 を Response throw して、
// stub 側で `ServerFnValidationError` 等の custom class に deserialize する経路を
// 入れるかどうかは Open Question (= ADR 0070 #6, dogfood で痛み顕在化したら起票)。
type CreatePostResult = { ok: true; slug: string } | { ok: false; fields: Record<string, string> };

// serverFn に **明示的な generic 引数** を渡して Handler の R を CreatePostResult
// (= 判別共用体) に固定する。inline annotation だと TS の variadic tuple inference
// で R が union のまま伝わらず、IDE の TS server が結果型を 1 branch に narrow する
// 事象を観測したため (= dogfood 第 7 周目で発見)。明示的指定で robust に倒す。
export const createPost = serverFn<[input: unknown], CreatePostResult>(async (_c, input) => {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const path = issue.path[0];
      if (typeof path === "string" && !(path in fields)) fields[path] = issue.message;
    }
    return { ok: false, fields };
  }
  const post = await db.createPost(parsed.data);
  return { ok: true, slug: post.slug };
});
