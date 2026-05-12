// /about/* 配下に被せる scoped layout。Step 5 (ADR 0080) dogfood 用に「PostsLayout と
// **構造が違う** layout」を用意して layout 切り替え navigation の挙動を試す。
//
// PostsLayout が sidebar + main の 2 column 構成なのに対し、AboutLayout は banner +
// content の 1 column 構成にして「見た目で違いが分かる」状態にしてある。

import { Frame } from "@vidro/hibana";

export function AboutLayout({ children }: { children: Node }) {
  return (
    <div style="padding: 24px;">
      <p
        data-testid="about-layout-banner"
        style="background: #fffbea; padding: 12px; border-left: 4px solid orange; margin-bottom: 16px;"
      >
        About 専用 layout (= AppLayout の中、PostsLayout は出ない想定)
      </p>
      <Frame>{children}</Frame>
    </div>
  );
}
