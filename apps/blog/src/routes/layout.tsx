import { Link } from "@vidro/router";
import type { Route } from "./+types";

// 公開側の root layout。header + nav + main の最小構成。
// 各 page は children として渡される。
// ADR 0067: `./+types` per-route codegen 経由で `Route.LayoutProps` を引く (root は params 空)。

const linkClass =
  "text-blue-600 hover:underline aria-[current=page]:font-bold aria-[current=page]:text-blue-800";

export default function RootLayout({ children }: Route.LayoutProps) {
  return (
    <div class="mx-auto max-w-2xl p-8">
      <header class="border-b border-gray-300 pb-4">
        <h1 class="text-2xl font-bold">Vidro Blog</h1>
        <nav class="mt-3 flex gap-4 text-sm">
          <Link href="/" class={linkClass}>
            Home
          </Link>
          {/* posts 詳細でも active を出したいので prefix match */}
          <Link href="/posts" match="prefix" class={linkClass}>
            Posts
          </Link>
        </nav>
      </header>
      <main class="pt-6">{children}</main>
    </div>
  );
}
