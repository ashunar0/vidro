# 0058 — `.server.tsx` semantics: server-only component file with Vidro RSC-like model

## Status

**Accepted** — 2026-05-06 (51st session、user 合意取得済)

依存: ADR 0057 (FW design stance)、ADR 0030 (renderToStringAsync)、ADR 0027 (hydrate primitive)
関連: ADR 0015 (Phase A bootstrap)、ADR 0035 (progressive hydration foundation)
後続予定: ADR 0059 候補 (partial hydration implementation)、ADR 0060 候補 (`.client.tsx` defer、必要時)

## Context

### 痛みの起点 — 47th〜49th 拡張子 5 道議論の空転

47th session で「拡張子の使い分け」議論が `1: signal 禁止 (Astro)` / `2: 両側実行` / `3: build tool auto-detect` / `4: .client.tsx を SSR opt-out marker` / `5: directive 流 (Astro client:*)` の 5 道で並列棚上げになった。原因は **上位 component 哲学が未確定** だったため。

49th で ADR 0057 (FW design stance: 強制せず機構誘導 + 公式推奨) が成立し、Component 哲学の "強制 vs 推奨" の置き場が固まった。これにより拡張子議論を **意味論レベル** で詰める素地が整った。

### 51st session で言語化された Vidro RSC-like の核心

memory `project_vidro_rsc_like_core_model` で整理された通り、Vidro が React RSC の simpler 代替になる構造的根拠は **invoke-once + signal が Flight を不要にする** こと:

- React: state 変化 → component 関数を再実行 → VDOM 比較 → DOM 更新。client が Server Component を「再 render する手段」を必要とするため、server-only API を踏まないように Flight に snapshot 焼いて持ち回す
- Solid/Vidro: invoke-once + signal、mount 後は signal の細粒度更新だけ。Server Component の再 render snapshot を client が持つ必要が **そもそも無い**。HTML 文字列で見えてるものが正解

これにより React RSC が Flight に依存して達成してる server/client component 分離を、Vidro は **HTML wire + 拡張子 marker** で構造的に simpler に達成できる。

### React RSC との対比 (memory より)

| 軸                        | React RSC                                  | Vidro                                |
| ------------------------- | ------------------------------------------ | ------------------------------------ |
| Wire format               | Flight (proprietary)                       | **HTML** (`project_html_first_wire`) |
| Server Component snapshot | Flight に embed                            | **不要** (invoke-once)               |
| Boundary marker           | `"use client"` directive (transitive 問題) | **拡張子** (`.server.tsx`、追跡不要) |
| Default mental model      | server (opt-in client)                     | **両側実行** (opt-out server)        |

### Vidro 既存の機構との接続

- `routes/.../server.ts` 既存 = server-only **logic** (loader / action) ファイル。本 ADR の `.server.tsx` はその component 版に相当
- HTML-first wire (`project_html_first_wire`) = navigation で boundary swap、`.server.tsx` の出力は再描画不要、wire model と完全 align
- ADR 0027 (hydrate primitive) / ADR 0030 (renderToStringAsync) = SSR / hydrate の足場、本 ADR の前提

## Options

### (A) Vidro 流: 拡張子 marker + 両側実行 default (= 採用案)

- `.tsx` (default) = 両側実行、bundle に乗る、signal 動く
- `.server.tsx` = server-only、bundle 除外、内部 signal は build error
- 内部に Client Component (`.tsx` import) を書ける = SSR で評価され HTML 化、bundle には Client Component のみ含まれる
- ADR 0057 (強制ゼロ + 機構誘導) と整合: 使わなくても動く optimization marker

### (B) React/Next 流: directive ベース

- `.tsx` で書く、`"use client"` / `"use server"` directive で boundary 表現
- transitive 問題 (= 一度宣言すると import chain 全部 client 扱い) が発生、build tool / user 双方で追跡負担
- 拡張子による explicit boundary より AI 親和性が劣る (LLM が import chain を辿らないと判定不能)
- Vidro 既存の `server.ts` 拡張子文化と不整合

### (C) Astro 流: server default (opt-in client)

- `.tsx` (default) = server-only static、`.client.tsx` で hydrate target 明示
- mental model が現状の Vidro と逆 = 既存 user code (= 全 `.tsx` で signal が動く前提) が動かなくなり migration 痛い
- Vidro target (= 個人/hobby/cf、一定 interactive) と Astro target (= 静的サイト主) が異なる

### (D) 完全自由 (= 拡張子 marker なし)

- 現状の Vidro = `.tsx` のみ、全部 bundle に載る
- bundle size 最適化の余地ゼロ
- React RSC simpler 代替 (`project_design_north_star` 北極星) を実装する道がない

## Decision

**(A) Vidro 流: 拡張子 marker + 両側実行 default** を採用する。

### Core statement

`.server.tsx` 拡張子は **server-only component file** を表す:

1. ファイル全体 (top-level の export 含む) が server で 1 回だけ評価される
2. bundle に乗らない (= client には存在しない)
3. 内部で `signal()` / `computed()` / `effect()` 等の reactive primitive を import / 使用すると **build error** (= 意味論レベルの誤用検出)
4. 内部に Client Component (`.tsx` import) は書ける = SSR で評価されて HTML 化、bundle には Client Component のみ含まれる
5. 戻り値 / props serialize は **JSON 表現可能な型** に限定 (start)
6. async function 可 (= DB fetch / fs read / server-only API)

### default `.tsx` の意味 (= 既存挙動の明文化)

`.tsx` (default) は **両側実行**:

- server で SSR (= renderToString)、client で hydrate
- signal は両側で動く (server で initial value 評価、client で reactive 化)
- bundle に乗る

### `.server.tsx` の使用例

```tsx
// routes/posts/[id]/index.server.tsx
import { Counter } from "./counter"; // .tsx (Client Component)
import { db } from "@/infrastructure/db";

export default async function PostPage({ params }: PageProps) {
  const post = await db.posts.find(params.id); // server-only API OK
  return (
    <article>
      <h1>{post.title}</h1>
      <p>{post.body}</p>
      <Counter initial={0} /> {/* Client Component、hydrate される */}
    </article>
  );
}
```

```tsx
// routes/posts/[id]/counter.tsx (= 両側実行 default)
import { signal } from "@vidro/core";

export function Counter({ initial }: { initial: number }) {
  const count = signal(initial);
  return <button onClick={() => count.value++}>{count.value}</button>;
}
```

### scope (= 本 ADR で扱う / 扱わない)

| 項目                                                   | 本 ADR で扱う?                                 |
| ------------------------------------------------------ | ---------------------------------------------- |
| `.server.tsx` の意味論定義                             | ✅                                             |
| signal 誤用の build error                              | ✅ (Decision に明記)                           |
| `.tsx` (= default) の挙動明文化                        | ✅                                             |
| Props serialize format (= JSON 限定 start)             | ✅                                             |
| Partial hydration / island hydration の implementation | ❌ (ADR 0059 候補に分離)                       |
| `.client.tsx` (SSR opt-out marker)                     | ❌ (YAGNI defer、ADR 0060 候補)                |
| 既存 routes の `.server.tsx` 移行                      | ❌ (本 ADR は意味論のみ、別 task)              |
| renderToStringAsync の default 化                      | ❌ (ADR 0030 で着地済、運用は ADR 0059 で扱う) |

### build error の対象

`.server.tsx` 内で以下の primitive を import / call すると build error:

- `signal()` / `computed()` / `effect()` (`@vidro/core` reactive primitive)
- `onMount()` (lifecycle primitive)
- `Resource` / `<Suspense>` (= reactive な data fetching primitive)

これらは `.server.tsx` の意味論で **動作しない** ため、build 時に教える。これは ADR 0057 の「思想レベルの強制ゼロ」と矛盾しない:

- ADR 0057 の「強制ゼロ」= 思想 / 哲学レベル (= db 直叩きするか、Container 分けるか 等)
- 本 ADR の build error = 意味論レベル (= 使えない API を使ってる、書いても動かない)

両者は別レイヤー。silent にすると AI / dev が「なんで動かない?」のデバッグサイクルを踏む (= 51st session で user 指摘)。早期発見が重要。

### Props serialize format

- start = JSON 限定 (= JSON.stringify で表現可能な型)
- Date / Map / Set / undefined / 循環参照は user 側で事前変換が必要
- 限界を踏んだら seroval (Solid 系譜) を採用検討、別 ADR で

理由:

1. **依存追加なし** = bundle / install footprint
2. **限界が明示的** = magic がない (`project_legibility_test` 整合)
3. **YAGNI** = toy 段階で踏まないかもしれない
4. **後付け可** = 困ってから seroval

### How to apply (将来の design 判断時)

- **新 server-only feature を追加する時**: `.server.tsx` (component) と `server.ts` (logic) のどちらに置くかは「JSX を返すか」で判断
- **既存 `.tsx` を `.server.tsx` に移す時**: signal / lifecycle / Resource を全部除去するか、別 file に切り出す
- **`.client.tsx` が欲しくなった時**: 単発 use case なら `if (typeof window !== "undefined")` guard で対応、複数出てきたら ADR 0060 起票

## Consequences

### Pros

- **React RSC の simpler 代替が成立** = `project_design_north_star` 北極星の具体実装
- **HTML wire と完全 align** = `project_html_first_wire` の boundary swap navigation と整合
- **ADR 0057 整合** = 使わなくても動く optimization marker、強制ゼロ stance を破らない
- **AI 親和** = 拡張子で boundary 即決、import chain 追跡不要 (= LLM が判定容易)
- **同 component (`.tsx`) の使い回し** = server から呼ぼうが client から呼ぼうが同じ
- **後付け楽** = `.tsx` → `.server.tsx` rename だけで bundle から外れる、影響範囲狭い
- **意味論レベルの誤用検出** = AI が signal 書いて silent に動かない事故を防ぐ

### Cons / Open Questions

- **partial hydration の implementation が前提**: 現状 full hydrate なので、本 ADR を Accepted にしても **bundle 削減効果は出ない**。effective に動かすには ADR 0059 (partial hydration) が必要。本 ADR は意味論先行、実効化は後続 ADR で
- **build error の plugin 改修**: `@vidro/plugin` で `.server.tsx` ファイルの AST scan が必要。edge case (= re-export, dynamic import, type-only import) の handling は実装段階 (= 0059) で詰める
- **renderToStringAsync を default 化する判断**: 本 ADR は async `.server.tsx` を許容するので renderToStringAsync が前提。ADR 0030 で着地済の async path を `.server.tsx` 用に default 化する運用は ADR 0059 で扱う
- **既存 routes の migration コスト**: `apps/router/` の既存 routes を `.server.tsx` に rename + signal 除去する dogfood は別 task。本 ADR は code 変更なし、意味論定義のみ
- **`.client.tsx` defer の妥当性**: window-only API / 重い library 用に必要性が出たら ADR 0060 で起票。現状は `.tsx` + `typeof window` guard で対応可能
- **Props serialize 限界の表面化**: Date / Map を頻繁に渡す use case が dogfood で出たら seroval 採用判断。それまでは JSON 限定
- **再描画 mechanism は本 ADR で再定義しない**: `.server.tsx` の出力は親 boundary swap で更新される (= memory `project_html_first_wire` で既に整理済)。本 ADR では参照のみ

### 既存 memory との関係

- `project_vidro_rsc_like_core_model`: 本 ADR の素材、Accepted 後も memory 維持 (= insight 記録として)
- `project_design_north_star`: 北極星 (RSC simpler 代替) の具体実装
- `project_html_first_wire`: 再描画 mechanism (= 親 boundary swap) で整合
- `project_rsc_like_rewrites`: touchpoints の `.server.tsx` 拡張子 boundary 部分を本 ADR で着地、残り (= Hydration marker shape、async renderToString default 化) は ADR 0059 で扱う
- `project_fw_design_stance` (ADR 0057): 「強制ゼロ」の意味論レベル例外 (= signal 誤用 build error) を本 ADR で定義
- `project_legibility_test`: 拡張子 boundary は legible (= モデルなしで読める)、合格
- `project_pending_rewrites`: Phase C の partial hydration 残課題 (= boundary owner dispose, fallback hydrate) は ADR 0059 で同時解決見込み

### 既存 ADR との関係

- **ADR 0057 (FW design stance)**: 強制ゼロ stance の意味論レベル例外 (= build error) を本 ADR で定義、矛盾なし
- **ADR 0030 (renderToStringAsync)**: 既に async render 着地済、本 ADR の async `.server.tsx` の足場
- **ADR 0027 (B-3d main hydrate)**: hydrate primitive、本 ADR の前提
- **ADR 0035 (progressive hydration foundation)**: partial hydration の足場、ADR 0059 で本 ADR に接続
- **ADR 0015 (Phase A bootstrap)**: server で loader data を JSON inject、本 ADR の Props serialize JSON 限定 stance と整合

## Affected files

- `docs/decisions/0058-server-tsx-semantics.md`: 本 ADR (新規)
- `~/.claude/projects/-Users-a-kawanobe-dev-prd-fw/memory/project_vidro_rsc_like_core_model.md`: 51st 起票済 (= 本 ADR の素材)
- (code 変更なし、本 ADR は意味論定義のみ)

## Validation

本 ADR は意味論定義の semantic ADR なので、code 検証ではなく以下で validate する:

- 既存 ADR (0001-0057) との矛盾なし check
- 既存 memory との整合 check
- `feature-dev:code-reviewer` agent review (= Accepted 化前、`feedback_review_in_workflow` per)
- 後続 ADR 0059 (partial hydration) で本 ADR の前提が技術的に成立するか確認
- dogfood: form sketch などで `.server.tsx` の dream code を書いてみる (= `feedback_dx_first_design` per)

## Next steps after Accepted

1. **ADR 0059 候補**: partial hydration implementation (= bundle 除外を effective にする)
2. **ADR 0060 候補 (defer)**: `.client.tsx` 必要性が出たら起票
3. **plugin 改修**: `@vidro/plugin` で `.server.tsx` ファイルの reactive primitive 検出 build error (= ADR 0059 で同時実装見込み)
4. **dogfood**: form / list / fetch / shared sketch で `.server.tsx` の dream code を試す
5. **`apps/router/` の routes migration**: 適切な route を `.server.tsx` に rename して bundle 削減効果を実測 (= 0059 で partial hydration 着地後)
