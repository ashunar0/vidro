// @vidro/hibana/Link — Step 5 (HTML swap navigation) の opt-in component。
//
// ADR 0080 案 1-B: 素の `<a href>` に `data-hibana-link` marker を付けるだけの軽量 component。
// client navigation runtime (= Phase 2 で実装) が `[data-hibana-link]` を検出して
// click intercept し、partial HTML wire で SPA 風 navigation を発火する。
//
// 書き忘れて素の `<a>` で書いた場合は graceful degradation で MPA 遷移する
// (= JS 切れと同じ挙動、ADR 0080 §軸 1-案 B cons)。internal/external link の判別は user 責任。
//
// ADR: docs/decisions/0080-hibana-html-swap-navigation.md

import { h } from "@vidro/core";

export type LinkProps = {
  href: string;
  children?: unknown;
};

export const Link = (props: LinkProps): Node =>
  h("a", { href: props.href, "data-hibana-link": "" }, props.children);
