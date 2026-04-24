import { Link, type LayoutProps } from "@vidro/router";

// 全 route で共通の root layout。元 main.tsx に直書きしてた header / nav / main
// wrapper をここに移した。{children} の位置にマッチした route + nested layout が
// 差し込まれる。
export default function RootLayout({ children }: LayoutProps) {
  return (
    <div style="font-family: system-ui, sans-serif; padding: 2rem; max-width: 640px; margin: 0 auto;">
      <h1>Vidro Router Demo</h1>
      <nav style="display: flex; gap: 0.75rem; padding: 0.5rem 0; border-bottom: 1px solid #ccc;">
        <Link href="/">Home</Link>
        <Link href="/about">About</Link>
        <Link href="/users">Users</Link>
        <Link href="/users/1">User 1</Link>
        <Link href="/users/5">User 5</Link>
        <Link href="/does-not-exist">404</Link>
      </nav>
      <main style="padding-top: 1rem;">{children}</main>
    </div>
  );
}
