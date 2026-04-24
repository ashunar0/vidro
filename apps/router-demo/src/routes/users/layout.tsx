import type { LayoutProps } from "@vidro/router";

// /users 配下 (= /users と /users/:id) で共通の nested layout。breadcrumb 風の
// 帯を出して、その下に matched route の中身を差し込む。dashed border は
// 「nested layout が wrap してる」ことを目視確認するための装飾。
export default function UsersLayout({ children }: LayoutProps) {
  return (
    <div
      data-testid="users-layout"
      style="border: 1px dashed #888; padding: 0.75rem; border-radius: 4px;"
    >
      <p style="margin: 0 0 0.5rem; font-size: 0.85rem; color: #666;">users layout (nested)</p>
      {children}
    </div>
  );
}
