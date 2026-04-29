# ADR 0046 — tsconfig は 3 file inline (Vite/vite-plus 公式準拠)、ADR 0013 の extends 路線を反転

- Status: Accepted
- Date: 2026-04-29
- 関連 ADR: 0013 (vidro output dir + tsconfig base extends), 0044 (boot helper), 0045 (vidro plugin facade & OXC)

## 背景 / 動機

`apps/core/` (CSR template) を起点に「使う側視点」で見直した結果、Vidro の
tsconfig が **業界標準と形が違う** ことが判明:

```jsonc
// Vidro 旧 (ADR 0013 路線)
{
  "extends": "@vidro/plugin/tsconfig.base.json",
  "compilerOptions": {
    "noUnusedLocals": true,
    "noUnusedParameters": true,
  },
  "include": ["src"],
}
```

vs. **Vite/vite-plus/React/Solid 全部共通の 3 file inline 構成**:

```
tsconfig.json          ← orchestrator (files: [], references)
tsconfig.app.json      ← src/ 用 (DOM lib + jsx + jsxImportSource)
tsconfig.node.json     ← vite.config.ts 用 (node types, no DOM)
```

特に `vp create vite:application -- --template react-ts` (vite-plus 公式) も
同じ 3 file 構成を生成する。React/Solid テンプレと完全一致。

ADR 0013 の extends 路線が選ばれた当初の動機は「user tsconfig が 1 行で済む」
だったが、実際の trade-off は:

| 観点                | 0013 extends 路線              | 3-file inline 路線               |
| ------------------- | ------------------------------ | -------------------------------- |
| user 認知           | 1 行 (簡単)                    | 3 file (Vite/Solid 民は知ってる) |
| 環境分離            | × DOM lib が node 環境に漏れる | ○ app/node を別 lib で型 check   |
| FW 規約変更の追従   | ○ extends 1 行で transparent   | △ user 側で値を更新              |
| 業界 convention     | × Vidro 独自                   | ○ vite-plus 公式準拠             |
| ex-React/Solid 体験 | △ 違和感                       | ○ 期待通り                       |

「ex-React/Solid ユーザーがそのまま乗り換えられる」を優先する設計判断
(`feedback_dx_first_design.md` / `project_design_north_star.md` 路線) と
「DOM/node 環境分離の正しさ」を考えると、3-file inline が勝つ。

## 設計判断

### 1. `@vidro/plugin/tsconfig.base.json` を廃止

`packages/plugin/tsconfig.base.json` を削除。`package.json` の `files` /
`exports` から `tsconfig.base.json` を除去。`@vidro/plugin` は plugin function
の export だけに集中する (副次 artifact を抱えない、clean な package boundary)。

### 2. apps の tsconfig は 3 file inline で構成

```jsonc
// apps/*/tsconfig.json (orchestrator)
{
  "files": [],
  "references": [{ "path": "./tsconfig.app.json" }, { "path": "./tsconfig.node.json" }],
}
```

`tsconfig.app.json` / `tsconfig.node.json` の中身は **vite-plus 公式テンプレ
完全準拠** + Vidro 特有 2 行 (`"jsx": "react-jsx"` + `"jsxImportSource": "@vidro/core"`)
を `tsconfig.app.json` 側に inline。

`tsconfig.app.json` は `include: ["src"]`、`tsconfig.node.json` は
`include: ["vite.config.ts"]`。router-demo は `.vidro/**/*.d.ts` (auto-gen
`routes.d.ts`) も app 側に追加。

### 3. `@types/node` を apps の direct devDependencies に追加

`tsconfig.node.json` の `types: ["node"]` を解決するため。catalog 経由
(`"@types/node": "catalog:"`) で workspace 全体で一致させる。

## 影響

### 削除

- `packages/plugin/tsconfig.base.json`

### 変更

- `packages/plugin/package.json` — `files` / `exports` から `tsconfig.base.json`
  削除
- `packages/plugin/src/route-types.ts` — comment から `tsconfig.base.json`
  への言及を新形式に修正
- `apps/core/tsconfig.json` — orchestrator 化 (references のみ)
- `apps/router-demo/tsconfig.json` — 同上
- `apps/{core,router-demo}/package.json` — `@types/node` を catalog から追加

### 新規

- `apps/core/tsconfig.app.json` / `apps/core/tsconfig.node.json`
- `apps/router-demo/tsconfig.app.json` / `apps/router-demo/tsconfig.node.json`

## 動作確認

- `vp check` 全 pass (formatting + types + lint、全 105 file)
- `apps/core` (port 5174): `vp dev` 起動、counter 描画 + 増分 ✓
- `apps/router-demo` (port 5175): `vp dev` 起動、`/notes` 遷移 ✓ console error/warning ゼロ

## trade-off / 代替案検討

### A. ADR 0013 の extends 路線維持 (= 何もしない)

却下。`vp create` を含む業界全体が 3-file inline 路線で揃ってる中、Vidro
だけ extends で頑張る差別化 value は薄い。`feedback_dx_first_design.md` の
「user が書くコードの見た目を起点に設計を見直す」原則と矛盾。

### B. extends 路線を維持しつつ tsconfig.base.json を app + node 2 ファイルに分割

3 file 化 + extends で Vidro 規約の transparent 配布を残す案。検討したが:

- vite-plus テンプレと「形」が完全一致しない (extends 行が余分)
- Vidro 規約の値 (`jsxImportSource: "@vidro/core"`) は変更頻度が低い (Solid の
  `solid-js` も基本変わらない) ので、inline 化のコストは事実上一回限り
- `@vidro/plugin` から tsconfig 配布する責務を切ることで package boundary が
  clean に

→ inline 路線を採用。将来 Vidro 側で tsconfig 規約変更が頻発するなら再評価する。

### C. vite-plus 公式 `vp create` を直接使ってもらう (Vidro template 提供しない)

却下。Vidro は `jsxImportSource: "@vidro/core"` 等の特有設定が要るので、create-vidro
CLI を将来用意する前提。`apps/core/` がそのまま template になる想定なので
vite-plus 公式テンプレと同形にしておく方が、create-vidro 着手時の差分が最小化。

## follow-up

- `create-vidro` CLI 着手時、`apps/core/` の 3 file 構成をそのまま template に
- ADR 0013 の決定文を見直し (歴史的経緯として残しつつ「ADR 0046 で extends 路線
  反転」を追記する形が妥当)
