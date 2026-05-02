import type { LayoutProps } from "@vidro/router";
import type { loader } from "./layout.server";

// /users 配下 (= /users と /users/:id) で共通の nested layout。layout 自身の loader
// を持ち、users 一覧を小さな badge で表示。leaf 側の loader と 並列 で fetch される。
// ADR 0042: layout.server.ts の action が更新する markedAt も表示。
export default function UsersLayout({ data, children }: LayoutProps<typeof loader>) {
  return (
    <div
      data-testid="users-layout"
      style="border: 1px dashed #888; padding: 0.75rem; border-radius: 4px;"
    >
      <p style="margin: 0 0 0.5rem; font-size: 0.85rem; color: #666;">
        <strong>users layout (nested)</strong> — {data.users.length} users in list
        {data.markedAt ? ` · marked at ${data.markedAt}` : ""}
      </p>
      {children}
    </div>
  );
}
