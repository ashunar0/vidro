// GET /posts/new = create form を空 state で render。
// POST /posts は ../index.tsx の `export const POST` 側にある (= route 表現上は同 path だが、
// new page を別 URL で出すのは Rails 流 /posts/new の慣例に整合)。

import type { Metadata } from "@vidro/hibana";
import { createRoute } from "@vidro/hibana/fs";
import PostNewPage from "../../../pages/PostNewPage.tsx";

export const metadata: Metadata = {
  title: "New Post",
  description: "新規 post の作成 form。",
};

export default createRoute((c) => c.render(PostNewPage, {}));
