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
      {/* dynamic を 1 つ (template literal で構成) にまとめないと、`<strong>` 等の
          static element と dynamic expression が混在し post-order の hydrate cursor
          が崩れる (ADR 0026 の cursor 整合制約)。元の `<strong>` 装飾を捨てて簡潔化。 */}
      <p style="margin: 0 0 0.5rem; font-size: 0.85rem; color: #666;">
        {`users layout (nested) — ${data.users.length} users in list${data.markedAt ? ` · marked at ${data.markedAt}` : ""}`}
      </p>
      {children}
    </div>
  );
}
