// ADR 0061 Phase 3-7 dogfood — `.server.tsx` page が render 中に throw した時、
// /__partial 経由で error.tsx 入り fragment (= 200 + error markup) が返って
// partial swap されることを確認する用。`.server.tsx` は loader を持たない設計
// (= ADR 0058 D-α-iii) なので、loader throw ではなく render-time throw で代替。
export default function BrokenServer(): never {
  throw new Error("意図的な render error なのだ (broken-server/index.server.tsx)");
}
