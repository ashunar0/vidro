# 0064 — Resource primitive 1-pass 統一 (renderToStringAsync + streaming SSR を async tree walk に)

## Status

**Accepted** — 2026-05-07 (52nd session、user 合意取得済)

依存: ADR 0030 (renderToStringAsync 2-pass)、ADR 0033 (out-of-order streaming)、ADR 0035 (progressive hydration foundation)、ADR 0036 (boot trigger)、ADR 0058 (`.server.tsx` semantics)、ADR 0060 (partial hydration)
関連: ADR 0028 (createResource client only)、ADR 0029 (Suspense primitive)、ADR 0063 (SSR throw shape)
defer 元: memory `project_pending_rewrites` Phase D 案件「Resource の 1-pass 化 (穴埋め化)」

後続予定: **ADR 0065 (= async server component native、h() の `Node | Promise<Node>` 拡張)** — 本 ADR の async tree walk 機構の上に load する独立 ADR。次セッションで draft。

## Context

### 痛みの起点 — 「正しい server component の使い方」でも DB query が 2x 飛ぶ

dogfood `apps/blog` で本物 DB に置き換えた時、`apps/blog/src/routes/posts/index.server.tsx` の記事一覧画面で `await db.posts.findAll()` を書きたい。これは server component の **正しい使い方** (= read + render、idempotent な data 取得) だが、現状の Resource (= ADR 0030) を経由すると 2-pass model のため:

```
[1-pass] PostsIndex() 1 回目 → fetcher 集める (markup 捨てる)
[resolve] Promise.allSettled
[2-pass] PostsIndex() 2 回目 → resolved 値で markup 完成
```

この流れで **DB query が 2 回飛ぶ** (1 page あたり 2 query)。read-only なので結果は壊れないが、純粋な性能問題。記事一覧 / 記事詳細 / トップページ 全ての SSR で発生する慢性コスト。

### 当時 2-pass を選んだ history (ADR 0030 論点 2)

ADR 0030 で 4 案 (2-a/2-b/2-c/2-d) から `2-a (2-pass renderToStringAsync)` を採用。理由:

- `2-b (1-pass + VNode 穴埋め)`: server-renderer 全面改修 + effect の再評価モデル破壊 ← **当時の toy runtime には複雑すぎた**
- `2-c (streaming SSR)`: Phase C 本命だが当時は過剰 (今は ADR 0033 で着地済)
- `2-d (markup loading=true、bootstrap data だけ inject)`: blink 残ってゴール未達

つまり 2-pass は **「正しさ保証 + 当時の実装簡素化」の妥協点**。実装が育った今 (Phase A〜C 完了 + ADR 0035/0036/0060 着地) は 1-pass に書き換える素地が整った。

### 今 1-pass 化に踏み込む追加の動機

memory `project_vidro_rsc_like_core_model` で整理済の通り、**invoke-once が Vidro identity の核**。2-pass model は「同じ component 関数が server で 2 回呼ばれる」= **invoke-once 違反** で、Vidro 哲学的に不純。後続 ADR 0065 (async server component native) で `async function Component()` を許容する時、2-pass で書くと user の `await db.findAll()` が 2 回走る現実問題が出る (= memory 不要、純粋な性能問題)。**先に Resource を 1-pass 化して async tree walk の足場を作っておくと、ADR 0065 が h() の async 化だけで自然に着地できる**。

### 主要な構造的観察 (= 1-pass 化が成立する根拠)

`feature-dev:code-explorer` 調査結果より:

1. **client async は要らない** (Q1 で確定済): `.server.tsx` 限定の async 機構なら、client renderer (`browserRenderer`) は影響を受けない
2. **Resource bootstrap data の wire format は不変**: `__vidro_data.resources` の hits Map shape は変わらない。client `readResourceBootstrap` も変更不要
3. **streaming SSR boundary-pass の hits 入り再評価は 1-pass model で不要**: 「boundary 内 Resource の settled を待って Node emit する」形に書き直し可能
4. **Suspense fallback の役割が純化する**: 1-pass で Resource が server で常に resolved になる ⇒ server 上で Suspense pending=true が起きない ⇒ fallback は **client-only の役割** に純化、設計として整合

### Vidro 哲学整合 (memory cross-check)

| memory                              | 関係                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------ |
| `project_vidro_rsc_like_core_model` | invoke-once 貫徹 = 2-pass 廃止で完全整合                                                   |
| `project_html_first_wire`           | wire format (HTML + bootstrap data) 不変、wire model 維持                                  |
| `project_design_north_star`         | RSC simpler 代替の核 = 1-pass async tree が後続 ADR 0065 で h() async 化を素直に可能にする |
| `project_legibility_test`           | Resource API は `r.value` 読み出しは不変、`await r.settled` を追加するだけで legible 維持  |
| `project_cache_as_fw_concern`       | Resource は薄い fw 内蔵のまま、@vidro/query (仮) との 2-tier 構造変えない                  |
| `project_pending_rewrites`          | Phase D 案件「Resource 1-pass 化」を本 ADR で解消                                          |
| `feedback_dx_first_design`          | dogfood で「DB query 2x 飛んでる」気付きから target syntax 起点で逆引き                    |

## Options

### 論点 1: Resource の async API shape (= server で即 await できる形)

#### (1-A) Resource instance に `readonly settled: Promise<void>` を追加 (= 採用候補本命)

- 既存 `r.value` getter / `r.loading` 等は **API 破壊なし**
- server side で `await r.settled` してから `r.value` を読む経路が拓ける
- 上位 component が選択的に await できる (= Suspense 経由 / 直接 await の両方が成立)
- factory 関数 `resource(fetcher, opts)` は同期のまま

#### (1-B) `resource()` factory 自体を async function 化

- `const r = await resource(fetcher, opts)` に変更
- API 破壊大きい、既存 callsite 全部書き換え
- factory が Promise を返す形は legibility は十分だが、dogfood 互換性で痛い

### 論点 2: ResourceScope の role 変更

#### (2-A) `fetchers` Map 廃止 + `resolved` registry 追加 (= 採用候補本命)

- `registerFetcher(key, fetcher)` を廃止
- 新 `registerResolved(key, value | error)` で Resource constructor が server mode 即 await 後に書き込む
- async tree walk 完了時に registry を `__vidro_data.resources` に JSON 化

#### (2-B) `fetchers` Map 維持 + `await all()` を Resource constructor 内に移譲

- 既存 fetcher 集積形を残す、ただし await を構築タイミングに前倒し
- 最小変更だが、scope の役割が「集める だけ」から「集めて await して resolved 返す」に膨らむ
- registry の責務が Resource scope にも server mode の async 駆動にも分散して把握コスト増

### 論点 3: streaming SSR (renderToReadableStream) boundary model

#### (3-A) boundary-pass 廃止 + boundary 内 Node を直接 emit (= 採用候補本命)

- 現状 `flushBoundary` の「hits 入り scope で再評価」を廃止
- boundary 内で Resource settled を待ってから boundary Node を組み立てて emit
- Suspense factory の childrenFactory pattern を維持しつつ、内部実装を「再評価」から「Node 待機」に変更

#### (3-B) 既存 boundary-pass 維持 + 内部だけ 1-pass async tree walk

- shell-pass / boundary-pass の段階分けは保つ、各 pass が内部で async tree walk
- 段階分けと async walk の役割が混ざる、把握コストが高い

### 論点 4: renderToString (sync) の扱い

#### (4-A) sync API 維持、Resource は server で `loading=true` の markup を produce (互換動作)

- 既存 `renderToString` (sync) はそのまま、async が要らない場合 (= test や client-only 経路) の用途を残す
- Resource を sync renderToString で評価したら 2-pass 互換の loading=true markup
- `renderToStringAsync` が新しい async tree walk 経路、これが production の主入口

#### (4-B) sync `renderToString` 廃止、全 SSR を async に統一

- API 破壊、既存 test 全面改修
- 互換性喪失大きい

### 論点 5: Suspense 上での Resource pending state

#### (5-A) server 上で Suspense pending=true が起きないことを「整合した帰結」として受け入れる (= 採用候補本命)

- 1-pass で Resource が server 即 await ⇒ pending 状態が server 側に出現しない
- Suspense fallback は **client-only の役割** に純化
- ADR 0029 (Suspense) の意味論は維持、ただし server の動作仕様が変わる旨を本 ADR で明文化

#### (5-B) Suspense 内で「server で fallback を出す」path を残す

- user が `<Suspense fallback={<Loading/>}>` で囲んだら、server でも fallback markup を出して boundary 化、boundary chunk で本物に差し替える (= ADR 0033 streaming model 踏襲)
- 1-pass tree walk と streaming boundary の併存設計が必要、複雑度上がる

## Decision

5 論点すべて確定 (= 52nd session、user 合意取得済):

- 論点 1: **(1-A) `r.settled: Promise<void>` を追加** ─ 既存 API 破壊なし、dogfood 互換、上位 component が選択的に await できる
- 論点 2: **(2-A) `fetchers` Map 廃止 + `resolved` registry 追加** ─ 役割が綺麗に分離 (= scope が「集める」から「resolved 値を保持」に)
- 論点 3: **(3-A) boundary-pass 廃止 + boundary 内 Node 直接 emit (= 並列 walk 形式)** ─ 詳細は下記「streaming SSR 意味論」参照
- 論点 4: **(4-A) sync `renderToString` 維持** ─ 互換性保護、test 影響最小化、Resource を含む経路だけ `renderToStringAsync` に切り替え
- 論点 5: **(5-A) server 上 pending=true 不在を整合した帰結として受け入れる** ─ Suspense fallback は client only 役割に純化、ただし streaming SSR 用 boundary marker としては server でも動作 (下記参照)

### streaming SSR 意味論 (= 論点 3 + 5 の確定形)

Vidro の SSR は **Suspense の有無で 2 モード** に分岐する:

| パターン                          | user が書くもの                    | server 動作                                                                                                                | 結果                                                                     |
| --------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **古典 SSR モード (default)**     | Suspense なし                      | 全 Resource を await → 完成形 HTML を 1 chunk で送る                                                                       | loading 見えない、TTFB は全 fetch 待ち、シンプル                         |
| **streaming SSR モード (opt-in)** | `<Suspense fallback={...}>` で囲む | shell + fallback markup 即 flush → 内側 subtree を **並列 1-pass walk** → resolve 順に boundary chunk emit + JS で差し替え | shell の TTFB 早い、loading 一瞬見える、`<Suspense>` 単位で out-of-order |

#### 「並列 walk」の核 (= React 流に寄せる判断)

各 Suspense boundary 内側は **独立した async tree walk として並列実行** する:

- 既存 `flushBoundary` (`/packages/core/src/render-to-string.ts:264-302`) の「boundary-pass で hits 入り再評価」path を廃止
- 代わりに「内側 subtree を **別 async タスク**として並列 walk、resolve 後に boundary chunk として emit」
- 各 walk は **1-pass、副作用 1 回** ─ user が書いた async function component の `await db.create()` 等が 2 回走らない
- 並列 walk = 複数 boundary が独立に進行、resolve 順に out-of-order emit (= ADR 0033 の out-of-order streaming 維持)

#### Solid 流 (subtree re-evaluation) を採らなかった理由

Solid Start は invoke-once + signal の cheap re-eval を活かして boundary 内側を 2-pass で再評価する。だが:

- Solid 自身が **async function component を採用していない** のは、まさに「2 回評価で副作用 2 回走る問題」を回避するため (= Resource / createAsync primitive で wrap させる)
- Vidro は **ADR 0065 (次セッション) で async function component native サポート** を予定 ⇒ boundary 内側を 1 回評価に固定する必要 (= React 流必須)

つまり Vidro は **server SSR streaming = React 流 (並列 walk)、client reactivity = Solid 流 (signal + cheap re-eval)** の synthesis (memory `project_vidro_position_synthesis` 整合)。

#### Vidro 哲学整合

- **memory `project_design_north_star`**: 個人/hobby/cf target → default 古典 SSR (シンプル) で十分、streaming は opt-in で残す
- **memory `project_fw_design_stance`**: 強制せず機構誘導 → user が `<Suspense>` 書いた時だけ streaming 動作
- **memory `project_vidro_rsc_like_core_model`**: invoke-once 貫徹 → 各 walk 1 回評価、副作用 1 回

### Scope (= 本 ADR で扱う / 扱わない)

| 項目                                                                            | 本 ADR で扱う?                                           |
| ------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------ |
| Resource を 1-pass async tree walk model に書き換え                             | ✅                                                       |
| `Resource.settled: Promise<void>` 追加                                          | ✅                                                       |
| `ResourceScope` role 変更 (`fetchers` → `resolved`)                             | ✅                                                       |
| `renderToStringAsync` の async tree walk 化                                     | ✅                                                       |
| streaming SSR (`renderToReadableStream`) boundary model 見直し                  | ✅                                                       |
| Suspense の server 動作仕様 update (= server 上で pending=true 不在)            | ✅ (明文化)                                              |
| `__vidro_data.resources` wire format 維持 + client `readResourceBootstrap` 不変 | ✅ (確認)                                                |
| \*\*`h()` の `Node                                                              | Promise<Node>` 拡張 (= async component native)\*\*       | ❌ (**ADR 0065 で扱う**) |
| **`async function Component()` 直書きサポート**                                 | ❌ (**ADR 0065 で扱う**)                                 |
| ADR 0063 (SSR throw shape) async reject 経路実装                                | ❌ (= async component 文脈なので ADR 0065 と並行 / 後続) |
| Resource API の Date / Map / Set 拡張                                           | ❌ (既存 JSON 限定維持、別 ADR で seroval 検討)          |

## Open Questions (= 実装着地時に詰める論点、次セッション以降)

> 注: 確定論点 (`.server.tsx` 限定 / 1-pass 統一 / streaming SSR 並列 walk / Suspense server pending=true 不在) は Decision セクション参照。本 section は実装段階で詰める detail のみ。

1. **既存 `apps/router/src/server.ts:578` の sync `renderToString` 呼び出しの扱い**
   - 方針: そのまま sync `renderToString` 維持 (Resource を含まない navigation 経路は sync で OK)
   - Resource を含む経路は `renderToStringAsync` に切り替え必要、影響範囲確認は実装時

2. **partial hydration (ADR 0060) との接続**
   - `.server.tsx` 内 Client Component (`.tsx` import) の island 範囲は async tree walk で markup 完成後に挿入される marker と整合するか動作確認
   - 1-pass async walk 中に既存 `runWithIslandScope` の動作が保たれるか確認

3. **既存 test の書き換え範囲確認**
   - `tests/render-to-string-async.test.ts`: 「`bootstrapKey` なし resource は loading=true で markup」「重複 key first-write-wins + warn 1 回」等の 2-pass 中間動作を assert している箇所は **書き換え or 削除** 必要
   - `tests/render-to-readable-stream.test.ts`: shell + boundary chunk emit 順序の expect が boundary-pass 廃止で変わる
   - 影響テスト数を実装着手時に確認

4. **Resource constructor の async 駆動方法**
   - 方針: (1-A) `r.settled: Promise<void>` だが、内部で fetcher を Promise.resolve で wrap して即 await する具体形
   - bootstrapKey 重複時の first-write-wins 動作は維持 (= 既存 test の assert は保つ)

## Consequences

### Pros

- **正しい使い方でも DB query 2x の慢性コスト解消** (= 記事一覧 / 記事詳細 等の SSR が常に 1 query で済む)
- **Vidro 北極星 (RSC simpler 代替) の足場完成** = 後続 ADR 0065 (h() async 化) を素直に load 可能、async tree walk が共通機構
- **invoke-once 哲学貫徹** = memory `project_vidro_rsc_like_core_model` と完全整合、Resource も「呼ばれるのは 1 回切り」
- **Resource API 後方互換** (1-A 採用時) = 既存 dogfood / test の callsite 大幅変更なし
- **wire format 不変** = `__vidro_data.resources` は変えない、client `readResourceBootstrap` 不変
- **Suspense fallback の役割純化** = client-only に明確化、設計が綺麗
- **`@vidro/query` 拡張パスを塞がない** = memory `project_cache_as_fw_concern` の 2-tier 構造 (薄い fw + 厚い query pack) を維持

### Cons / 残るリスク

- **streaming SSR boundary model の全面書き直し** = `flushBoundary` (`/packages/core/src/render-to-string.ts:264-302`) を中心に最大の改修箇所
- **既存 test の書き換え** = 2-pass 中間動作を assert していた箇所は書き換え or 削除必要 (詳細は実装着手時)
- **`server-renderer.ts` `serialize()` への影響可否** = tree 完成後 sync serialize で済むなら不要、async tree walk 中に部分 serialize するなら拡張必要 (= 実装方針で確定)
- **shell-pass async 化に伴う TTFB 影響** = `renderToReadableStream.start(controller)` 内で shell-pass が `await` 1 回増える、計測必要
- **Resource error 経路の再設計** = 1-pass で Resource が server で reject した時、`#applyBootstrapHit` ではなく Resource instance state に書き込む必要、SerializedError 経路の挙動確認

### 既存 ADR との関係

- **ADR 0030 (renderToStringAsync 2-pass)**: 本 ADR で 2-pass model を 1-pass model に置き換え、ADR 0030 の Decision を **superseded by ADR 0064** にマーク
- **ADR 0033 (out-of-order streaming)**: streaming model は維持、boundary-pass の内部実装だけ書き換え
- **ADR 0029 (Suspense)**: server 上 pending=true 不在を意味論明文化追加 (= 本 ADR で明記)
- **ADR 0036 (boot trigger)**: 影響なし (shell flush 後 hydrate 起動の流れ不変)
- **ADR 0058 (`.server.tsx` semantics)**: bundle 除外 / signal/effect/onMount 禁止の意味論不変
- **ADR 0060 (partial hydration)**: island registry / partial hydrate model 不変、async tree walk 上での marker 挿入動作確認 (Q5)
- **ADR 0063 (SSR throw shape)**: 本 ADR は Resource の sync 経路の reject 整理、async component の reject 経路は ADR 0065 文脈で並行 / 後続実装

## Affected files (実装着地時、次セッション)

- `packages/core/src/resource.ts`: Resource constructor の server mode を即 await 化、`settled: Promise<void>` 公開
- `packages/core/src/resource-scope.ts`: `fetchers` Map 廃止 + `resolved` registry 追加
- `packages/core/src/render-to-string.ts`: `renderToStringAsync` を async tree walk 形式に書き直し、`renderToReadableStream` の `flushBoundary` を boundary-pass 廃止形に
- `packages/core/src/suspense.ts`: server 上 pending=true 不在の意味論明文化、streaming branch を boundary Node 待機形に
- `packages/core/src/streaming-scope.ts`: boundary registry の interface 変更可能性
- `packages/core/src/owner.ts`: 影響なし (本 ADR では sync 維持、ADR 0065 で async 化)
- `packages/core/src/server-renderer.ts`: `serialize()` 不変見込み (tree 完成後呼ぶ前提)
- `packages/router/src/server.ts`: sync `renderToString` 経路はそのまま、Resource を含む経路は `renderToStringAsync` に切り替え (Open Questions Q1)
- `packages/core/tests/render-to-string-async.test.ts`: 2-pass 中間動作 assert 部分の書き換え or 削除
- `packages/core/tests/render-to-readable-stream.test.ts`: shell + boundary chunk emit 順序 expect の更新
- `packages/core/tests/resource-bootstrap.test.ts`: client 側不変、影響軽微
- `packages/core/tests/resource.test.ts` / `reactive-resource.test.ts`: client mode 主体、影響軽微

## Validation (= Accepted 化までに実施済)

- 既存 ADR (0001-0063) との矛盾なし check ✅
- 既存 memory との整合 check (= 上記 cross-check 表で実施済) ✅
- `feature-dev:code-reviewer` agent review (52nd session、memory `feedback_review_in_workflow` per) ✅

## Next steps (= 次セッション以降)

### 段階的 commit (Phase 1 → 2 → 3 → 4 推奨順序、`feature-dev:code-explorer` 報告より)

1. ResourceScope role 変更 + `resolved` registry 追加
2. Resource server mode 即 await 化 + `settled: Promise<void>` 追加
3. `renderToStringAsync` を async tree walk 形式に書き換え
4. `renderToReadableStream` の boundary model 見直し (= boundary-pass 廃止 + 並列 walk)

各 Phase で既存 test pass 確認 (壊れた test は修正)。dogfood: `apps/blog` で本物 DB 想定 mock を入れて Resource 経由 await 動作確認 (= ADR 0065 着地前は `await r.settled; r.value` 経由)。

### ADR 0065 draft → Accepted (本 ADR の上に load)

- h() 戻り型 `Node | Promise<Node>` 拡張
- `ServerComponent<P>` 型導入 (TypeScript 型分離)
- async component の reject 経路 (= ADR 0063 実装と並行)
- shell-pass 内 async component の TTFB 動作明文化

### dogfood 完成 (ADR 0065 後)

- `apps/blog/src/data/posts.ts` を Promise 化 → `.server.tsx` で `await db.findAll()` 直書き → 動作確認
