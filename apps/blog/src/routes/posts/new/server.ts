// dogfood 第 7 周目 (2026-05-10): feature-based 切り分け。
// serverFn 本体は features/posts/server.ts、本 file は wire boundary だけ持つ
// 1 行 re-export (= router の compileRoutes が本 file の export を URL に bind)。
export { createPost } from "../../../features/posts/server";
