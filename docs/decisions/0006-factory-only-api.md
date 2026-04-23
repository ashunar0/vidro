# 0006 — primitive 生成 API を factory 一本化、class を internal に

## Status

Accepted — 2026-04-23

## Context

`Signal` / `Computed` / `Ref` / `Effect` の 4 primitive は、従来 class (`new X(...)`)
と factory (`x(...)`) の両方を public export していた。ただし `Effect` だけは

- 戻り値を使わない `new Effect(fn)` → ESLint `no-new` 違反
- `const _eff = new Effect(...)` → TypeScript `noUnusedLocals` (TS6133) で弾かれる
- `_` prefix は TS の未使用 local には効かない

の理由で factory `effect(fn)` が推奨になっており、**3 兄弟 (class) + Effect (factory) の
非対称**状態だった (設計書 §3.1 の「対称性維持」原則に反する)。

「class を internal に隠して factory に一本化するか」を判断する。

## Options

### (A) 現状維持: class + factory 両対応

- Pros: 書き手の好みに対応、TC39 Signal 提案の `new Signal.State(0)` に近い見た目
- Cons: 学習点 2 つ、AI-native 哲学 (判断点を減らす) と整合しない

### (B) factory に一本化、class を internal

- Pros:
  - 4 primitive 全て `x(...)` で対称 (§3.1 原則遵守)
  - 判断点ゼロ、AI-native と整合
  - API 表面が小さい (public export が減る)
- Cons:
  - 設計書 §3.1 target syntax の `new Signal(0)` と乖離 → 設計書更新対象
  - 既存コードに codemod 必要 (`new X(...)` → `x(...)`)

### (C) class に一本化、factory を internal

- Pros: TC39 Signal proposal / 設計書 target syntax と一致
- Cons:
  - **Effect を class に統一できない** (Context で述べた lint/TS 制約)
  - 非対称が残る、§3.1 に反する
  - lint / TS 設定を緩めるのは型貫通哲学から後退

### (D) 現状維持 + docs / 例示だけ factory に統一

- Pros: 既存コード変更なし、hedge できる
- Cons: 判断先延ばし。書き手は結局両対応を学ぶ必要あり

## Decision

**(B) factory に一本化、class を internal** を採用する。

- `packages/core/src/index.ts` は factory (`signal` / `computed` / `ref` / `effect`)
  のみ値 export
- class は `export type { Signal }` などで型のみ export (型注釈目的で引き続き使える)
- class 本体 (constructor) は module 内に残すが external から `new` で構築する口を閉じる
- テスト内で class instance が必要な箇所 (型注釈 `let eff: Effect` 等) は
  internal import (`from "../src/effect"`) で対応

## Rationale

### Effect の制約を受け入れる前提だと (B) だけが対称

- Effect は lint/TS 制約で factory しか現実的に使えない (今回 class 統一を試みて
  頓挫した経緯あり、`project_signal_api_decision` memory 参照)
- 3 兄弟も factory で揃えれば 4 primitive 全て factory、学習点が 1 つに収束

### TC39 Signal proposal 互換はすでに成立していない

- TC39 は `.get()` / `.set()` method、Vidro は `.value` property (Vue ref 流儀)
- class/factory 選択と互換性は独立の問題。native Signal が来ても独自 API として共存

### 逆行コストの非対称性

- factory → class 復帰は「export 1 行追加」で済む
- class → factory 移行は Effect が踏んだ lint/TS の壁で困難
- 将来 class を公開したくなったら後から足す方が安全

### subclass 拡張ニーズは低い

- Signal は値の箱。機能拡張は compose (Solid の createResource 等) が primitive FW の流儀
- 万一必要になっても後から class 公開で対応可能

## Consequences

- 設計書 (`~/brain/docs/エデン 設計書.md`) §3.1 の target syntax は更新対象
  (`new Signal(0)` → `signal(0)`)。brain は外部リポジトリなので別途反映
- テストの「両形式」describe は削除 (signal / effect / ref / computed)
- `Signal<T>` などの型注釈は引き続き書ける (`export type` で提供される)
- TC39 Signal proposal が native 化した際、Vidro の `signal()` はラッパーとして残り、
  native を使いたい場合は `new Signal.State(0)` を直接呼ぶ運用になる
- apps/website / packages/core/tests の `new X(...)` は全て codemod (sed) で置換済み

## Revisit when

- TC39 Signal proposal がブラウザ native 化して、Vidro でも TC39 互換 API を併置
  したくなった時 — 独自 class を再公開する可能性
- ユーザーから subclass 拡張の具体的ニーズが出た時 — 1 件でも聞こえなければ YAGNI
