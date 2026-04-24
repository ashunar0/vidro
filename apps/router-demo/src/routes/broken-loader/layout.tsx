import type { LayoutProps } from "@vidro/router";
import type { loader } from "./layout.server";

// layout loader error の階層伝播テスト用。この layout の loader は必ず throw するので、
// この layout 自身は mount されず、外側 (= root) の error.tsx が使われる想定。
export default function BrokenLoaderLayout({ data, children }: LayoutProps<typeof loader>) {
  return (
    <div
      data-testid="broken-loader-layout"
      style="border: 1px dashed #888; padding: 0.75rem; border-radius: 4px;"
    >
      <p>broken-loader layout (should NOT be rendered when loader throws)</p>
      <p>data: {JSON.stringify(data)}</p>
      {children}
    </div>
  );
}
