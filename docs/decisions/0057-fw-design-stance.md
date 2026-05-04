# 0057 — Vidro FW design stance: 強制せず機構誘導 + 公式推奨

## Status

**Accepted** — 2026-05-04 (50th session、user 合意取得済 + reviewer agent fix 反映済)

依存: なし (= meta-level な philosophical ADR、既存 ADR の上位概念)
関連: ADR 0007 (props proxy)、ADR 0048 (props snapshot + explicit reactive)、ADR 0049 (loaderData primitive)

## Context

### 痛みの起点 — 47th Tier S 仮説 → 49th counter sketch dogfood

47th session で「Component は pure rendering only、logic は別 file」という **Tier S 仮説** を立てた。これを 49th で `apps/core/src/components/Counter.tsx` の strict 改造案で dogfood しようとしたら、user (あさひ) から 5 段階の引っかかりが出た:

1. **「インクリメントって何するの」** — trivial logic を extract する負の価値 (= 抽象化負債 > 利益)
2. **「frontend logic は backend ほど境界がきれいに定まらない」** — granularity の幅が広い
3. **「component にも kind がある (page-level vs UI primitive)」** — monolithic に語れない
4. **「FSD は北極星だが counter で 6 層は多すぎ」** — 規模感の mismatch
5. **「FW がこれを強要しちゃ本来良くない」** ← 本 ADR の core insight

5 番目が決定的だった。Rails 流の規約強制は user の自由を奪うし、Vidro の target 規模 (個人 / hobby / cf、`project_design_north_star`) では over-engineering になる。

### 観察 — Hono の "Controller 作るな" は強制ではない

Hono は「Controller 作るな」を docs で公式推奨するが、強制機構は持たない。**型推論が引き出す自然な形** (= route handler に直書きする方が型が綺麗、controller 経由だと型情報が壊れる) で誘導されているだけ。

→ これは強制ゼロでも「自然な書き方」が出現する設計。Vidro にも全面適用したい。

### Vidro 既存の機構誘導 (= 既に部分実装)

- `loaderData<typeof loader>()` の型推論 → loader を route file 直書きが最も気持ち良い → controller 作ると型壊れる = 自然に避ける (= Hono "Controller 作るな" の Vidro 版)
- signal が module scope OK → 外出し easy、component scope も自由
- `.server.ts` / `.client.ts` 拡張子 → server/client 分離が自然に表現
- JSX invoke-once → component を pure に書くと runtime コスト最小

### Vidro 既存 ADR との整合

- **ADR 0007 (props proxy)**: 当時の決定は props 全 reactive 化だったが、ADR 0048 で props snapshot に override 済。これは「強制 reactive」を「明示 primitive で opt-in」に softening した先例で、本 ADR の stance と整合
- **ADR 0049 (loaderData primitive)**: route 直書きの自然さを支える primitive。本 ADR の機構誘導の代表例

## Options

### (A) 強制せず機構誘導 + 公式推奨 (= 採用案)

- 公式推奨は持つ (docs / tutorial)
- 機構 (= 型 / API / lifecycle) で自然に良い形に誘導
- linter は警告止まり、error / runtime 破綻にしない
- 規模に応じて 2-6 層に伸縮できる scale-aware design

### (B) Rails 流の規約強制

- folder 構造、layer 分離、命名規則を runtime / lint error で強制
- 大規模プロジェクトでは一貫性確保に有効
- 個人 / hobby 規模では over-engineering、Vidro target に合わない
- user の自由を奪う = `project_design_north_star` の北極星 (個人/hobby/cf) と矛盾

**ただし注記**: build tool 由来の hard enforcement (= `.server.ts` / `.client.ts` 拡張子 boundary が bundling で物理的に分離される等) は B でなく **A の範囲内** として許容する。これらは "policy として強制" でなく "機構の物理特性として自然に分離" される性質のもので、A の機構誘導と整合する。区別の基準: lint rule で policy を強制するなら B、build / runtime の物理機構が結果として boundary を引くなら A。

### (C) 完全自由 (= 公式推奨ゼロ)

- 公式 docs は API reference のみ、architecture 推奨を持たない
- user に全部委ねる
- AI コード生成時に判断軸が無い → AI native 性が薄れる
- noun-first / 型貫通 / OOUI といった Vidro identity が伝わらない

## Decision

**(A) 強制せず機構誘導 + 公式推奨** を採用する。

### Core statement

Vidro は **「強制しない、機構が自然に良い architecture に向かう」** FW を目指す。

- 公式推奨は持つ (= guidance / docs)
- Rails 流の硬直は避ける
- 規模に応じて **2-6 層に伸縮** できる scale-aware design
- **Noun-first / OOUI / 型貫通** が公式推奨の北極星

### 3 つの強度の置き場

| 強度         | 場所                          | 例                                                               |
| ------------ | ----------------------------- | ---------------------------------------------------------------- |
| **明示推奨** | docs / tutorial               | "Vidro 流: noun-first FSD 風 folder、2-6 層伸縮"                 |
| **暗黙誘導** | 機構 (= 型 / API / lifecycle) | signal module scope / 型貫通 / 拡張子 boundary / JSX invoke-once |
| **強制ゼロ** | linter は警告止まり           | error / runtime 破綻にしない                                     |

### Scale-aware FSD の伸縮 (公式推奨側)

| 規模             | 層                                  | 例           | Vidro target           |
| ---------------- | ----------------------------------- | ------------ | ---------------------- |
| XS (counter/toy) | pages + components                  | 1-2 file     | ✅ 中心                |
| S (blog/todo)    | pages + features + shared           | 3-4 folder   | ✅ 中心                |
| M (dashboard)    | pages + widgets + features + shared | 4-5 folder   | ✅ 想定範囲            |
| L (大規模)       | 完全 FSD 6 層                       | full-fledged | ⚠️ target 外、参考のみ |

規模が育つと層が増える設計。最初は 2 層、必要になったら裂く (= split-when-confused、`project_3tier_architecture` と整合)。

**L 行について**: Vidro の北極星 (`project_design_north_star`) は個人 / hobby / cf 規模なので、L (大規模) は **target 外**。表に載せるのは「規模 axis の上限を示す参考」のため。L 規模で必要な機能は `@vidro/pack` (architecture pack) や external tooling で対応する想定で、core / router の公式推奨は M までを想定する。

### How to apply (将来の design 判断時)

- **新 primitive / API を design する時**: 「これ強制になってないか」を check。強制なら "機構が引き出す" 形に reframe できないか考える
- **公式推奨を docs に書く時**: "推奨" であって "規約" じゃない言い回しを徹底
- **規模感の判断**: 「個人 / hobby / cf 規模で over-engineering じゃないか」を check
- **noun-first / 型貫通 / OOUI** を公式推奨の北極星として参照
- **新 ADR を書く時**: "禁止 / 違反 = error" の表現を避け、"推奨 / 違反 = 警告" の表現に

## Consequences

### Pros

- user の自由が保たれる = `project_design_north_star` (個人/hobby/cf 規模) と整合
- AI コード生成時に "公式推奨" が判断軸として機能 (= AI native 性維持)
- 規模に応じて層を増減できる = 小規模 over-engineering 回避
- 機構誘導は強制でないので backwards compatible (= 既存 user code を破壊しない)

### Cons / Open Questions

- **公式推奨と AI 学習データの相互作用**: 公式 docs に書いた推奨が AI に学習されることで "暗黙の規約" 化する可能性。これは Hono でも起きてる現象で、Vidro でも welcome (= AI native 性の発露)
- **機構誘導の盲点 — 第一候補は Component kind 分離**: 「強制したくないが、機構誘導で引き出せない」領域の既知具体例として **Container / Presentational の kind 分離** がある。型 / lifecycle / build tool では誘導できず、純粋に user の判断に委ねざるを得ない。50th 以降の sketch dogfood (form / list / fetch / shared component) で観察し、(a) 公式推奨止まりで受け入れる / (b) DX ガイド (eslint plugin / template / docs 例) で補う / (c) 機構誘導の余地を再探索 のいずれを取るか決める
- **規模 scale の境界曖昧**: XS/S/M/L の境界は厳密でない。これは intentional (= 連続的な伸縮)、boundary を硬直させない
- **既存 memory の retroactive cleanup**: `project_layer_separation_principle` 内の `lint rule` YAML ブロックに "違反は build time error" の strict 表現が残存 (= 49th softening 時に top-level 注記は追加したが YAML 中身は手付かず)。本 ADR Accept と同時に該当 YAML を "違反は警告" に書き換える。今後類似の strict 表現が memory / docs に発見されたら本 ADR stance に合わせて softening する

### 既存 memory との関係

- `project_design_north_star`: 北極星 (RSC simpler 代替) はそのまま、本 ADR は **method 側**
- `project_3tier_architecture`: split-when-confused と整合
- `project_fw_design_stance`: 本 ADR の memory 版 source、ADR Accepted 後も memory 維持
- `project_responsibility_separation_focus`: 49th で softening 済 (kind 分離前提、Container 内蔵 OK / Presentational pure 推奨)
- `project_component_philosophy_pending`: 49th で softening 済 (kind 分離前提で 5 軸を kind ごと評価)
- `project_layer_separation_principle`: 49th で softening 済 (4 層分離は公式推奨レベル、強制ゼロ)
- `project_type_vertical_propagation`: noun-first / 型貫通 と整合

## Affected files

- `docs/decisions/0057-fw-design-stance.md`: 本 ADR (新規)
- `~/.claude/projects/-Users-a-kawanobe-dev-prd-fw/memory/project_layer_separation_principle.md`: lint YAML 内 "違反は build time error" → "違反は警告" に softening (= reviewer agent finding #1)
- (code 変更なし)

## Validation

本 ADR は philosophical な meta-level decision なので、code 検証ではなく以下で validate する:

- 既存 ADR (0001-0056) との矛盾なし check (= reviewer agent confirm 済、特に 0007 / 0048 / 0049 と整合)
- 既存 memory (`project_*`) との整合 check (= 49th softening 済の 3 memory + 本 ADR で `project_layer_separation_principle` の lint YAML も softening)
- `feature-dev:code-reviewer` agent review: critical 0、major 2 + minor 2 件 → 全件反映済
- 50th 以降の sketch (form / list / fetch / shared component) で違和感が出ないか dogfood

## Review Findings

`feature-dev:code-reviewer` agent (50th session、Proposed 段階):

- **Major (88)**: `project_layer_separation_principle` 内の lint YAML に "違反は build time error" が残存し本 ADR と live 矛盾 → memory 側 YAML を "違反は警告" に softening + Consequences に retroactive cleanup item 追加
- **Major (85)**: 機構誘導の盲点を "現時点では具体例なし" として流したが Component kind 分離 (Container/Presentational) は既知の具体例 → Open Question を actionable に書き換え (sketch dogfood で観察、3 つの対応 option 明示)
- **Minor (78)**: Option B が strawman 気味、build tool 由来の hard enforcement (拡張子 boundary) は B でなく A 範囲内 → Option B に区別の基準を注記
- **Minor (80)**: Scale table の L 行 (大規模 / 完全 FSD 6 層) が `project_design_north_star` の "大規模 non-goal" と矛盾 → L 行に "target 外、参考のみ" 注記 + 表に Vidro target 列追加

## Next steps after Accepted

1. 50th 以降の sketch dogfood で本 stance の効力を検証 (= form / list / fetch / shared)
2. Component kind 分離の機構誘導余地を sketch で観察 (= Open Question #2)
3. 違和感あれば本 ADR を amend or supersede
4. 公式 tutorial / docs に "公式推奨" の言い回しを反映 (= 将来 task)
