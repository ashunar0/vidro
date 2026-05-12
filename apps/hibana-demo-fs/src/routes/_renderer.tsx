// filesystem-based 版の global layout。`/_renderer.tsx` が root 配下 (= 全 route) に scoped。
// 中身は src/layouts/AppLayout.tsx を default export として re-export するだけ:
//   - layout component 自体は src/layouts/ に置いて、UI 組織観点で自由に配置 (= 設計書「強制せず推奨」)
//   - src/routes/_renderer.tsx は filesystem routing 規約の "薄い橋渡し"
//
// この re-export pattern なら、layout component の物理配置を変えても src/routes/_renderer.tsx
// の import path を 1 行直すだけで済む = filesystem 規約と domain folder 哲学の両立。

export { AppLayout as default } from "../layouts/AppLayout.tsx";
