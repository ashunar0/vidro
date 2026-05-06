# 0063 — SSR throw shape: discriminator marker + bootstrap data Error serialize

## Status

**Accepted** — 2026-05-06 (56th session、ADR 0061 Phase 3-7 dogfood で発見した抜けに対する後追い ADR / user 合意取得 / 未着工)

依存: ADR 0060 (partial hydration / `__VidroServerOnlySection`)、ADR 0058 (.server.tsx semantics)、ADR 0021 (ErrorBoundary)、ADR 0010 (loader error serialize)
関連: ADR 0031 (streaming SSR)、ADR 0035 (段階 hydration)、memory `project_design_north_star` / `project_vidro_rsc_like_core_model`

## Context

### ADR 0061 Phase 3-7 dogfood で発見した「ハリボテ hydrate」問題

`.server.tsx` 内で意図的に throw する dogfood (`apps/router/src/routes/broken-server/index.server.tsx`) を直アクセス SSR で踏むと、画面は正しく error.tsx が見えるが console に下記 error が連鎖する:

```
[router] render error: Error: [hydrate] skipToComment: marker "vs-1-end" not found
[router] layout render error: Error: [hydrate] cursor exhausted while expecting text "Something went wrong"
```

### 構造分析

**server SSR**:

1. `__VidroServerOnlySection` の wrapper が `<!--vs-1-start-->` を streaming SSR で flush 済
2. 内側 component が **throw**
3. router の ErrorBoundary が catch → error.tsx に切り替え
4. **対の `<!--vs-1-end-->` を出さずに別経路に折り返した**

**client hydrate**:

1. `__VidroServerOnlySection` stub が cursor walk で `vs-1-end` を探す
2. **無い** → `marker "vs-1-end" not found`
3. 連鎖して error.tsx の text node も cursor miss

**ユーザー視点**: SSR HTML に error.tsx の markup は焼かれているので **画面は正しく見える**。だが client JS は hydrate で死亡 → Retry button 等の interactivity が一切効かない (= 「ハリボテ画面、JS としては死んだ page」)。

### 設計の北極星との関係

memory `project_design_north_star` / `project_vidro_rsc_like_core_model` で Vidro は **React RSC の simpler 代替** を目指す。memory `project_pending_rewrites` の「`async function Component()` (= ADR 0058 想定の `await db.x()`) 未対応」項目で **優先度 高**、すなわち `.server.tsx` 内 async component 直叩きを将来許容する。

→ async component が日常的に **外部 API failure 等で throw を踏む** ため、SSR throw shape を堅牢化する必要がある。

### Next.js App Router (RSC) の参考

App Router は React Flight (RSC payload) 上で server で起きた error を **明示的な protocol chunk** として client に伝える。Vidro は HTML wire (= memory `project_html_first_wire`) なので Flight chunk そのままは使えないが、**HTML marker + bootstrap data の組み合わせで同じ発想を翻訳できる**。

## Options

### A. discriminator marker + bootstrap data に Error serialize (= 採用案)

server 側 SSR で `.server.tsx` section が throw した時:

1. `<!--vs-N-start-->` flush 済でも続行
2. **discriminator marker** (= `<!--vs-N-error-->` 仮称) を出力
3. error.tsx の HTML を section pair 内 / 外いずれかに流す (= Open Question 1)
4. bootstrap data の layers[N] に `{ error: { message, name } }` を serialize
5. **必ず `<!--vs-N-end-->` を閉じる**

client hydrate:

1. `__VidroServerOnlySection` stub が cursor walk で `vs-N-error` を検出
2. bootstrap data の layers[N].error から **Error instance を復元**
3. **client 側で同じ throw を再現** → 通常 `.tsx` の throw と同じ shape に揃う
4. 通常 ErrorBoundary が catch → error.tsx hydrate → Retry 等 interactivity 復活

### B. section 単位 buffer + 全消し

`.server.tsx` section の出力を **buffer** して全成功してから flush。throw 時は buffer を捨てて通常 error 経路に倒す。

#### 不採用理由

1. **streaming を section 単位で犠牲** = TTFB / LCP 影響
2. **async component (= ADR 0058 北極星) と両立しない** = await 中の time cost が直に client 待ち時間になる
3. wire shape の透明性 / legibility では優れるが、北極星優先で却下

### C. 何もしない (= 現状維持)

`.server.tsx` 内 throw は user 責任とし、ハリボテ hydrate を許容。

#### 不採用理由

1. ADR 0058 想定の async component を入れた瞬間、外部 API failure 等の throw が日常化
2. production scale で blocker

## Decision

**案 A 採用**。実装は本 ADR とは別 commit、次セッション以降で詰める (= ADR 0062 のとき方針確定 → 別 commit で実装、と同パターン)。

## Consequences

### Pros

1. **`.server.tsx` 内 throw 後も hydrate が整合** = Retry / island の interactivity 復活
2. **streaming SSR を section 単位で犠牲にしない** = TTFB / LCP 利益キープ
3. **async component (= ADR 0058 北極星) と両立** = await 中も shell は client に流れる
4. **Next.js App Router 流の発想を HTML wire に翻訳** = Flight chunk → HTML marker + bootstrap data

### Cons / Trade-offs

1. **実装複雑度** = 中〜高 (= bootstrap data の Error serialize、client stub の walk + 復元、streaming の buffer 戦略)
2. **wire 表現の追加** = `<!--vs-N-error-->` discriminator + bootstrap data の error field
3. **server stack の漏洩 risk** = stack trace を serialize すると security 影響、production sanitize 規約必要

### YAGNI (= 本 ADR では入れない)

- error chain (`cause`) の serialize
- 復元時の constructor 復元 (= TypeError vs Error 区別)、Error 1 種で十分
- per-component scope の Error 細粒度 (= component tree depth ごと)
- production の dev/prod sanitize layer (= 別 ADR)

## Implementation Plan

### Phase 1: server-side SSR throw shape

1. `__VidroServerOnlySection` の throw catch path を追加
2. `<!--vs-N-error-->` discriminator marker を出力
3. error.tsx の HTML 配置 (= Open Question 1 の decision に従う)
4. bootstrap data layers[N] に `{ error: { message, name } }` serialize
5. `<!--vs-N-end-->` を必ず閉じる

### Phase 2: client-side stub + Error 復元

1. stub cursor walk で `vs-N-error` 検出 path 追加
2. bootstrap data から Error instance 復元
3. 通常 ErrorBoundary に再 throw → error.tsx hydrate

### Phase 3: dogfood + tests

1. broken-server route (= ADR 0061 Phase 3-7 で追加済) で hydrate 整合確認 (= Retry button が動く)
2. `packages/router/tests/server-only-section.test.ts` (新規) で marker shape を pin
3. streaming 中 throw / streaming 完了後 throw 両 case の挙動確認

### 工数見積

合計 **~300-500 行** (= 実装 + test + docs)、ADR 1-2 サイクル (= 1-2 セッション)。

## Open Questions

実装着手前に decide する項目 (= 設計議論を user と詰めて固める):

1. **error.tsx markup の配置**: `vs-N-start` / `vs-N-end` pair の **内側** に流すか **外側** に流すか
   - 内側: client stub が walk 中に拾う、closure scope 自然、ただし stub が「自分の中身が error.tsx だ」と知る経路が複雑
   - 外側: section pair は空、外側の通常 ErrorBoundary 経路で error.tsx hydrate、stub は単に skip
2. **bootstrap data の Error shape**: `message` のみか、`name` 含めるか、`stack` を dev mode のみ含めるか。production sanitize 規約と密接
3. **streaming SSR で `<!--vs-N-start-->` flush 済の throw**: 既に client に送ったバイトは取り戻せない前提を明示
4. **async component (= ADR 0058 別 ADR) との合流**: 案 A 自体は sync 前提でも書けるが、async 対応 ADR との実装ポイント被りを記録
5. **client 側 再 throw のタイミング**: mountChildren 中か effect 中かで cursor 状態が変わる、ErrorBoundary 経路の整合確認
