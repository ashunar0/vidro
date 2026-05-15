# 0083 — Hibana sibling は `@vidro/zod` を共用する (= `@vidro/hibana-zod` 別 package を YAGNI で却下)

## Status

**Accepted** — 2026-05-15 (= 第 27 周目 78th session、1 commit で Phase 1〜5 着地、両 app dev curl smoke pass + `vp check` 0 errors + `packages/zod` test 4/4 pass)

経緯:

- 第 25 周目 (= 76th session) CRUD form dogfood で痛み点 F6 (= `fieldsFromZodError` の 3 file 重複) を発見、`@vidro/hibana-zod` 別 package を起票候補として持ち越し (= memory [[project_hibana_crud_dogfood_findings]])
- 第 27 周目 (= 78th session) F6 解消方針の議論で「`@vidro/zod` を sibling 共用」案 B を user 採用、`@vidro/hibana-zod` 別 package は YAGNI で却下。規模小 + logic 変更ゼロ + helper の sibling 共用判断のため code-reviewer は skip、1 commit で Accepted 昇格

依存: ADR 0071 (`@vidro/zod` opt-in pack)、ADR 0073 (= ADR 0071 validator middleware を `serverFn` validator slot に統合、`@vidro/zod` は helper-only に縮退)
関連: [[project_hibana_overview]], [[project_hibana_crud_dogfood_findings]] (= 第 25 周目 F6 発見)、[[project_3tier_architecture]], [[project_legibility_test]], roadmap-hibana.md

## Context

第 25 周目 CRUD form dogfood (= 2026-05-13、`5cfeb87`) で発見した痛み点 **F6** (= `fieldsFromZodError` helper を 3 file に inline 複製、Hibana に validation 機構なし) を解消する ADR。

3 file の重複箇所:

- `apps/hibana-demo/src/domains/posts/routes.ts` (= handler-based 版、create + update)
- `apps/hibana-demo-fs/src/routes/posts/index.tsx` (= fs-based 版、create)
- `apps/hibana-demo-fs/src/routes/posts/[id]/index.tsx` (= fs-based 版、update)

3 file とも完全に同 logic (= ZodError.issues を flatten、`Record<string, string>` で各 field の最初の error message を返す)。Vidro 側は ADR 0071 + ADR 0073 で `@vidro/zod` package が同 helper (= `fieldsFromZodError`) を export 済 (= validator middleware は ADR 0073 で `serverFn` validator slot に吸収され、`@vidro/zod` は実質 helper-only に縮退)。

roadmap-hibana.md には将来 `@vidro/hibana-zod` 別 package が予告されていたが、本 ADR で YAGNI 観点から **sibling 共用** に倒す判断を記録する。

## Options

### 論点 1: package 位置

#### (1-A) `@vidro/zod` を Hibana sibling から共用 (= **採用**)

両 Hibana app の `package.json` に `@vidro/zod: workspace:*` を追加、3 file の inline 複製を `import { fieldsFromZodError } from "@vidro/zod"` に置換。

- **pros**:
  - 既存 package そのまま再利用 = impl 重複ゼロ、新 package 0 個追加
  - `@vidro/zod` は ADR 0073 以降 helper-only 縮退、router 不知 (= peer dep 整理後)
  - YAGNI 整合 = Hibana 固有 helper (= `validateForm(c, schema)` 等) は痛みが顕在化したら追加検討
  - 3-tier 構造の +pack tier を Vidro/Hibana で共有 (= sibling 関係の実証)
- **cons**:
  - package 名が `@vidro/*` のまま (= Hibana app から見ると namespace が odd)。ただし helper の impl が完全に同 logic なので命名コストを払う価値は無い

#### (1-B) `@vidro/hibana-zod` 新 package (= 却下)

roadmap-hibana.md 当初案、`packages/hibana-zod/` 新規。

- 却下理由:
  - impl が `@vidro/zod` と完全に同一 (= ZodError → `Record<string, string>` 変換)、package 分割の正当化材料なし
  - 「将来 Hibana 固有 helper を追加する伸び代」は YAGNI に反する (= 痛みが顕在化してから別 package 起票で十分)
  - roadmap 「@vidro/hibana-zod」は本 ADR で正式に却下マーク、必要時に再起票

#### (1-C) `packages/utils/` に helper を移動して両 FW から import (= 却下)

- 却下理由:
  - `@vidro/zod` の Vidro 側 import path が breaking change (= 既存 ADR 0071 + 0073 の README / example も書き換え必要)
  - `packages/utils/` は現状 scaffold 状態 (= description: "A starter for creating a TypeScript package.")、helper 寄せの先例なし
  - sibling 関係を素直に表現すれば `@vidro/zod` 共用で済む

→ **(1-A) 採用**。

### 論点 2: `@vidro/zod` の peer dep 整理

ADR 0071 起票時、`@vidro/zod` の `peerDependencies` には `@vidro/router: workspace:*` が含まれていた (= 当時の `validator(schema)` middleware が `serverFn` 用 middleware だったため)。ADR 0073 で validator middleware は `serverFn` 内 validator slot に吸収され、`@vidro/zod` は `fieldsFromZodError` helper のみ残った。

現状 `fieldsFromZodError` の impl (= `packages/zod/src/fields-from-zod-error.ts`) は `@vidro/router` を import しない、pure な ZodError 変換 helper。Hibana app から `@vidro/zod` を install する際に `@vidro/router` peer dep 警告が出るのは不要なノイズ。

#### (2-A) `@vidro/router` peer dep を削除 (= **採用**)

ADR 0073 (= validator middleware 統合) と整合、helper-only `@vidro/zod` の実態を反映。`zod` peer dep は維持 (= `fieldsFromZodError` が ZodError 型を引数に取るため)。

#### (2-B) 維持

- 却下理由:
  - 現状の helper-only 実装と整合しない (= 機能上の依存ゼロ、peer dep として残す理由なし)
  - Hibana app から install すると不要警告
  - ADR 0073 の意図 (= `@vidro/zod` 役割縮退) を peer dep に反映する方が clean

→ **(2-A) 採用**。

## Decision (= 2 論点まとめ)

| #   | 論点          | 決定                                                                                   |
| --- | ------------- | -------------------------------------------------------------------------------------- |
| 1   | package 位置  | **`@vidro/zod` を Hibana sibling から共用** (= 別 package なし、3 file の inline 削除) |
| 2   | peer dep 整理 | **`@vidro/router` peer dep を削除** (= ADR 0073 helper-only 縮退と整合)                |

## Rationale

### 「sibling 共用」が筋である理由

Vidro と Hibana は memory [[project_hibana_overview]] が示す通り、`@vidro/core` を **共有 sibling** として持つ関係。`@vidro/zod` の `fieldsFromZodError` も同様に sibling-shared にすれば、ADR 0073 で helper-only に縮退した実態と整合する。「Hibana 固有」のロジックは現時点でゼロ (= ZodError 変換は両 FW 共通)、新 package 分割の正当化材料がない。

memory [[project_3tier_architecture]] の +pack tier は **機能でなく環境で切る** という方針。`fieldsFromZodError` は zod 環境に依存するが Hibana / Vidro どちらでも動く (= 環境差異なし)、つまり tier 構造で見ても sibling 共用が自然。

### `@vidro/hibana-zod` を将来書く時の retreat path

`validateForm(c, schema)` 等の **Hibana 固有 helper** (= `c.req.formData()` を内包する高 level API) が必要になった時点で `@vidro/hibana-zod` を新規起票する道は残る。その時は:

- `@vidro/zod` は変わらず低 level helper (= `fieldsFromZodError`) のまま
- `@vidro/hibana-zod` は `@vidro/zod` を dependency として取り込み、上に Hibana 固有 wrapper を載せる

本 ADR では「Hibana 固有 helper の必要性が顕在化していない」ことを根拠に YAGNI を選択。痛みが出たら別 ADR で起票。

### legibility test (memory [[project_legibility_test]])

`import { fieldsFromZodError } from "@vidro/zod"` は「Vidro の zod pack から helper を import」と訳せる。Hibana app から `@vidro/*` を import するのは `@vidro/core` `@vidro/hibana` の前例 (= roadmap 上の sibling 構造) があるので、odd には見えない。

## Consequences

### Pros

- **F6 解消** (= 3 file の inline 重複ゼロ化、追加 / 修正時の同期忘れリスク消失)
- **新 package 0 個** (= roadmap の `@vidro/hibana-zod` 想定を YAGNI で却下、複雑度増えない)
- **peer dep 整理** (= `@vidro/zod` の helper-only 実態が package.json に反映、ADR 0073 と整合)
- **sibling 関係の実証** (= `@vidro/core` に続いて `@vidro/zod` も共有、3-tier の +pack tier が両 FW で機能する証明)

### Cons / 残るリスク

- **package 名が `@vidro/*` のまま** (= Hibana app から見ると namespace 不一致だが、impl 完全同一なので命名コストを払う価値なし)
- **Hibana 固有 helper を追加する場合に `@vidro/zod` が肥大化するリスク** (= ただし本 ADR では Hibana 固有 helper は出さない、必要時に `@vidro/hibana-zod` 別起票で対処)

### 既存 ADR との関係

- **ADR 0071 (`@vidro/zod` opt-in pack)**: 整合、本 ADR は ADR 0071 の package 利用を Hibana に拡張
- **ADR 0073 (`serverFn` object slot signature)**: 整合、本 ADR の peer dep 整理は ADR 0073 で `@vidro/zod` が helper-only 縮退した実態を反映

### roadmap-hibana.md との関係

「将来の opt-in pack 候補」セクションの `@vidro/hibana-zod` は本 ADR で **削除 + 注釈追加** (= 「ADR 0083 で sibling 共用に倒した、必要時に再起票」)。

## Affected files

- `packages/zod/package.json`: `peerDependencies` から `@vidro/router` 削除
- `apps/hibana-demo/package.json`: `dependencies` に `"@vidro/zod": "workspace:*"` 追加
- `apps/hibana-demo-fs/package.json`: 同上
- `apps/hibana-demo/src/domains/posts/routes.ts`: inline `fieldsFromZodError` 削除 + `@vidro/zod` import 追加
- `apps/hibana-demo-fs/src/routes/posts/index.tsx`: 同上
- `apps/hibana-demo-fs/src/routes/posts/[id]/index.tsx`: 同上
- `docs/roadmap-hibana.md`: `@vidro/hibana-zod` 行を「ADR 0083 で sibling 共用 / 必要時 retreat」注釈に更新

## Validation (= Accepted 化までに実施)

- `vp check` (= typecheck + lint) pass
- 両 Hibana app の dev で CRUD validation 失敗 path smoke (= 空 title submit → `/posts/new` で fields error 表示)
- `vp test` (= `@vidro/zod` の既存 unit test pass) 再確認
- user 合意取得 (= 第 27 周目 78th session で 案 B (= 共用) 選択済)

## Next steps (= Accepted 化後)

### 段階的 commit 推奨順序

1. **Phase 1**: ADR 0083 Draft 起票 + roadmap 更新 (= 本 commit)
2. **Phase 2**: `@vidro/zod` の peer dep 整理 (= `@vidro/router` 削除)
3. **Phase 3**: 両 Hibana app に `@vidro/zod` dep 追加 + 3 file の inline 削除
4. **Phase 4**: dev smoke (= 両 app で validation 失敗 path 確認)
5. **Phase 5**: Status Draft → Accepted 昇格 + memory 更新

各 Phase は独立 commit 可能。規模が小さいので Phase 2+3 をまとめる選択肢もあり。

## Revisit when

- **Hibana 固有 form helper の必要性が顕在化** (= `validateForm(c, schema)` / `useFormData(c)` 等の `c.req.formData()` を内包する高 level API) → `@vidro/hibana-zod` 別 package 起票
- **`@vidro/zod` の async refinement / nested field サポート要望** → ADR 0071 revisit と連動
- **schema lib 切り替え (valibot 等) 需要顕在** → ADR 0071 §論点 4 (= duck-type 案 4-B) と同期で再評価
