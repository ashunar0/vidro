import type { LoaderArgs } from "@vidro/router";

// layout loader が必ず throw するテストルート。Phase 3 第 3 弾 (ADR 0010) の
// 「layer の外側 error.tsx が使われる」挙動を確認するための回帰ケース。
export async function loader(_args: LoaderArgs) {
  throw new Error("broken-loader: layout loader always throws");
}
