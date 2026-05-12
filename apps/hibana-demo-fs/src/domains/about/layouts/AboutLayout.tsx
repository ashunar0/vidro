// /about/* 配下に scoped な layout (filesystem-based 版)。
// src/routes/about/_renderer.tsx で default 再 export される。
//
// PostsLayout と構造の違う layout を用意して、`/posts ⟷ /about` の layout 切り替え
// navigation で「共通祖先 = AppLayout までは保持、それ以下を swap」を視覚的に観察する dogfood。

import { Frame } from "@vidro/hibana";

export function AboutLayout({ children }: { children: Node }) {
  return (
    <div style="padding: 24px;">
      <p
        data-testid="about-layout-banner"
        style="background: #fffbea; padding: 12px; border-left: 4px solid orange; margin-bottom: 16px;"
      >
        About 専用 layout (filesystem-based 版、AppLayout の中、PostsLayout は出ない想定)
      </p>
      <Frame>{children}</Frame>
    </div>
  );
}
