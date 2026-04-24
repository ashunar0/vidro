import type { LayoutProps } from "@vidro/router";

// render error の階層伝播テスト用。layout 関数自体が throw するので ErrorBoundary
// が catch し、root error.tsx で置き換わる想定 (内側 error.tsx は使われない)。
export default function BrokenRenderLayout(_props: LayoutProps) {
  throw new Error("broken-render: layout render always throws");
}
