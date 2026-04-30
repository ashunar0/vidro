import { Link, type LayoutProps } from "@vidro/router";

const linkClass =
  "text-blue-500 hover:underline aria-[current=page]:font-bold aria-[current=page]:text-blue-700";

export default function RootLayout({ children }: LayoutProps) {
  return (
    <div class="mx-auto max-w-2xl p-8">
      <h1 class="text-2xl font-bold">Vidro Router</h1>
      <nav class="mt-4 flex gap-4 border-b border-gray-300 pb-2">
        <Link href="/" class={linkClass}>
          Home
        </Link>
        <Link href="/about" class={linkClass}>
          About
        </Link>
        <Link href="/users" match="prefix" class={linkClass}>
          Users
        </Link>
        <Link href="/notes" class={linkClass}>
          Notes
        </Link>
        <Link href="/broken" class={linkClass}>
          Broken
        </Link>
        <Link href="/does-not-exist" class={linkClass}>
          404
        </Link>
      </nav>
      <main class="pt-4">{children}</main>
    </div>
  );
}
