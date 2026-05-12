// @vidro/hibana/Frame — Step 5 (HTML swap navigation) の boundary marker component。
//
// ADR 0080 案 3-C: layout component 内に `<Frame>{children}</Frame>` で書き、
// partial HTML swap の boundary marker を兼ねる。server render 時は `<hibana-frame>`
// Custom Element 風 tag を吐き、client navigation runtime (= Phase 2 で実装) が
// この marker を find して内側を innerHTML 差し替えする。
//
// 名前由来: Frame ≒ Flame (= Hono = 炎、Hibana = 火花 と命名統一、第 22 周目発見)。
//
// 書き忘れて `{children}` だけ書いた layout は graceful degradation で動く
// (= partial swap が効かないだけ、page 自体は children として render される)。
// dev warning は Phase 5 で実装、書き忘れ検出する。
//
// data-layout (= layout name) の inject は Phase 3 で server renderer 経由で
// 後処理する想定 (= 現在は marker のみ minimum)。
//
// ADR: docs/decisions/0080-hibana-html-swap-navigation.md

import { h } from "@vidro/core";

export type FrameProps = {
  children?: unknown;
};

export const Frame = (props: FrameProps): Node =>
  h("hibana-frame", { "data-hibana-frame": "" }, props.children);
