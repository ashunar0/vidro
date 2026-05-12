// GET / の handler。filesystem 規約: app/routes/index.tsx → /。
// c.text の例 (= c.render 通らない handler の動作確認も兼ねる)。
// metadata 無し = default fallback title (= "Hibana Demo FS") が出る。

import { createRoute } from "@vidro/hibana/fs";

export default createRoute((c) => c.text("Hibana demo (fs) — try /posts"));
