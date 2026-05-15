# 0084 — Hibana flash 機構 (= `c.flash` + `flash()` reader、session 経由、type 別 method)

## Status

**Draft** — 2026-05-15 (= 第 27 周目、78th session)

依存: ADR 0082 (= `<Form>` submit intercept、success path で URL 制御確立、flash は意図的 scope 外)
関連: [[project_hibana_overview]], [[project_hibana_layout_direction_pending]] (= fs 本命暫定方針)、[[project_hibana_crud_dogfood_findings]] (= F2 success path 通知の起票材料)、[[project_html_first_wire]]、[[project_legibility_test]]、[[project_design_north_star]]、[[project_api_design_philosophy_object_one_spread]]

## Context

第 25 周目 CRUD form dogfood (= 2026-05-13、`5cfeb87`) で発見した痛み点 **F2 success path** の自然な続き。ADR 0082 で `<Form>` submit intercept + redirect follow + URL 制御を解消したが、**「Post created」等の 1 回限り通知 (= flash)** を出す機構は意図的に scope 外として残した。

業界先行例:

| FW      | 格納先             | server API                             | client API                                         |
| ------- | ------------------ | -------------------------------------- | -------------------------------------------------- |
| Rails   | session            | `flash[:notice] = "..."`               | view binding `<%= flash[:notice] %>`               |
| Remix   | session (= cookie) | `session.flash("key", "...")`          | `useLoaderData().toast` + `useEffect(() => toast)` |
| Inertia | server FW 依存     | `redirect()->with('success', '...')`   | `usePage().props.flash.success`                    |
| Hotwire | (機構なし)         | (Rails session 流用)                   | —                                                  |
| HonoX   | (機構なし)         | (`hono-sessions` 等で user が自前構築) | —                                                  |
| sonner  | (client-side only) | —                                      | `toast.success("...")` / `toast.error("...")` 等   |

→ **PRG (Post/Redirect/Get) 流の HTTP semantics に乗る場合だけ必要な primitive**。redirect 経由でない通知 (= client button click → toast / async fetch 結果) は island 内で imperative `toast(msg)` 直呼びで完結、flash 機構不要。

Hibana の制約 + 哲学:

- **MPA + 小 islands モデル** ([[project_hibana_overview]]) = server-rendered HTML + 部分 hydrate、Inertia 流 SPA + JSON wire とは別 axis
- **強制ゼロ** ([[project_design_north_star]]) = flash 採用は user 判断、redirect 経由通知が無い app は使わない
- **薄い core + 厚い optional pack** = flash 機構は `@vidro/hibana` 本体に組み込む (= session middleware は peer dep)
- **HTML-first wire** ([[project_html_first_wire]]) = flash data は SSR で焼き込まれて island に hydrate される (= JSON wire の例外条項該当)
- **fs 本命の暫定方針** ([[project_hibana_layout_direction_pending]]) = ADR 0084 dogfood は **fs 主導**、handler-based 版は並走維持の sub dogfood

## Options

### 軸 1: 格納先

#### (1-A) session 経由 (= **採用**)

`hono-sessions` peer dep を取り、Hono session middleware の上に乗る形で `c.flash` / `flash()` を実装。

- **pros**:
  - 業界 de-facto (= Rails / Remix / Inertia 全て session 経由)
  - 1 request で read + clear が自動 (= cookie set-header 経由)
  - shape 拡張余地 (= 将来 multiple flashes / object 形 / type 拡張)
- **cons**: session middleware の install + setup が user 必須

#### (1-B) cookie 直書き (= signed cookie で flash 1 個だけ持つ)

- 却下: session 抽象なし、multiple flashes / type 拡張で破綻、Hono ecosystem との重複

#### (1-C) 自前小 store (= memory 等)

- 却下: stateful、scaling 不可、Hono ecosystem に乗らない

→ **(1-A) 採用**。

### 軸 2: storage backend default

#### (2-A) cookie-based (= **採用**)

flash は 1 message + type の小データ (= 100 byte 以下)、cookie size 制限 (= 4KB) 余裕、CF Workers 含めて scaling 問題なし、sticky store 不要。

- **pros**: dev / prod 同じ、CF Workers 整合 ([[project_hibana_overview]] primary target)、複数 worker / serverless で共有可
- **cons**: 任意の重い data を flash に入れると 4KB 超えリスク (= ただし shape 制約で抑制)

#### (2-B) memory store

- 却下: dev のみ、prod 不可

#### (2-C) CF KV / Redis 等の external store

- 却下: dogfood overkill、flash には不要

→ **(2-A) 採用**。

### 軸 3: server API (= type 表現)

#### (3-A) method 別 (= sonner mirror) (= **採用**)

```ts
c.flash("Post created"); // type = "default"
c.flash.success("Post created"); // type = "success"
c.flash.error("Failed");
c.flash.warning("Slow network");
c.flash.info("New feature available");
```

- **pros**:
  - sonner の `toast.success` / `toast.error` と完全 mirror、client-side で `toast[f.type](f.message)` 1 行 wire
  - Rails / Inertia 流の de-facto mental model
  - TypeScript literal type で typo build error
  - 拡張 path = `c.flash(message, type?)` 関数形に retreat 可能
- **cons**: method 集合を機構が固定 (= 4 種 + default、user 自由拡張は別 ADR)

#### (3-B) 関数形 (= `c.flash(msg, type?)`)

- 却下 (= 候補維持): type 自由だが sonner method 直結性が弱い、typo build error 弱い

#### (3-C) object 1 個受け (= `c.flash({message, type})`)

- 却下: flash は 2 値小データ、object 強制で冗長、Vidro 哲学 ([[project_api_design_philosophy_object_one_spread]]) は多 field primitive 向け

→ **(3-A) 採用**。

### 軸 4: multiple flashes

#### (4-A) 1 個上書き (= **採用**)

```ts
c.flash.success("Post created");
c.flash.error("Email queue failed"); // ← 上書き、success 消える
```

- **pros**: minimal、shape 単純、YAGNI 整合
- **cons**: 「success + warning 同時表示」が機構レベルで不可 (= ただし user は message 連結で対応可)

#### (4-B) array で保持

- 却下 (= 候補維持): shape 複雑化、痛みが顕在化したら別 ADR で拡張

→ **(4-A) 採用**、痛み顕在化したら revisit。

### 軸 5: client API (= 取り出し)

#### (5-A) `flash()` reader 1 個 (= **採用**)

```ts
import { flash } from "@vidro/hibana";

const f = flash(); // { message: string, type: FlashType } | undefined
if (f) toast[f.type](f.message);
```

- **pros**:
  - minimal、1 関数で済む
  - server-side (= layout / page) と island の両方で呼べる (= ALS 経由 context 取り出し)
  - read + clear が自動 (= session に書き戻し、cookie response header に set)
- **cons**: `useFlash()` 命名と異なるが `use` 接頭辞は Vidro / Hibana で意図的回避 ([[project_api_design_philosophy_object_one_spread]] 整合)

#### (5-B) `useFlash()` (= React 流)

- 却下: `use` 接頭辞は React rules-of-hooks 文脈、Hibana の invoke-once モデルと不整合

#### (5-C) `<Flash />` 機構内蔵 component

- 却下: shadcn / sonner / Mantine 等の任意 toast lib との競合、機構 default UI は YAGNI、user 自由 UI が筋

#### (5-D) page props 経由 (= server 側 `c.render(Page, { flash: c.consumeFlash() })`)

- 却下: 全 page で flash props relay の boilerplate、layout / page どこからも取り出したい要件と不整合

→ **(5-A) 採用**。

### 軸 6: shape

#### (6-A) `{ message: string, type: FlashType }` (= **採用**)

```ts
type FlashType = "default" | "success" | "error" | "warning" | "info";
type Flash = { message: string; type: FlashType };
```

- **pros**:
  - 2 値小 shape、cookie size 余裕
  - sonner method 名と type 値が直結
  - 拡張余地 (= `description` / `action` / `duration` を将来追加可能、ただし initial scope 外)
- **cons**: 4 種固定 (= 軸 3 と連動)

#### (6-B) `string` のみ

- 却下: type 表現不可、toast UI で `toast.success` / `.error` 直結不能

#### (6-C) object 自由 (= `Record<string, unknown>`)

- 却下: shape 不定で type-safe 性低下、Hibana の薄い core 哲学と不整合

→ **(6-A) 採用**。

### 軸 7: 機構内蔵 UI component

#### (7-A) 出さない (= user 任意) (= **採用**)

shadcn / sonner / Mantine / Radix 等の任意 toast lib を user 自由に統合、機構は wire (= `c.flash` + `flash()`) のみ提供。

- **pros**:
  - 強制ゼロ、Hibana 哲学整合
  - shadcn / sonner と用途完全整合 (= 業界 de-facto)
  - 機構 surface 最小
- **cons**: default UI が無いので、初期 user が UI 自作の cost を払う (= ただし sonner 等の lib が 1 行 install で済む)

#### (7-B) 機構内蔵 `<Flash />` component (= default UI 提供)

- 却下: shadcn / sonner との競合、user が custom 不可、機構 surface 増

→ **(7-A) 採用**。

## Decision (= 7 軸まとめ)

| #   | 軸              | 決定                                                                       |
| --- | --------------- | -------------------------------------------------------------------------- |
| 1   | 格納先          | **session** (= `hono-sessions` peer dep)                                   |
| 2   | storage backend | **cookie-based default**                                                   |
| 3   | server API      | **method 別** (= `c.flash` + `.success` / `.error` / `.warning` / `.info`) |
| 4   | multiple        | **1 個上書き** (= YAGNI、痛み顕在化で revisit)                             |
| 5   | client API      | **`flash()` reader 1 個**                                                  |
| 6   | shape           | **`{ message: string, type: FlashType }`**                                 |
| 7   | 機構内蔵 UI     | **出さない** (= user 任意 toast lib)                                       |

### Scope (= 本 ADR で扱う / 扱わない)

| 項目                                                     | 本 ADR で扱う?                                             |
| -------------------------------------------------------- | ---------------------------------------------------------- |
| `c.flash(msg)` + `c.flash.{success/error/warning/info}`  | ✅                                                         |
| `flash()` reader (= server-side / island 両対応)         | ✅                                                         |
| `hono-sessions` peer dep + cookie-based default          | ✅                                                         |
| session middleware setup の dogfood example              | ✅                                                         |
| 両 app (= fs 本命 / handler 並走) で sonner 統合 dogfood | ✅                                                         |
| `c.rerender(data)` (= 同 page 再描画)                    | ❌ (= ADR 0085 候補、別議論)                               |
| multiple flashes (= array で保持)                        | ❌ (= 痛み顕在化で revisit)                                |
| 機構内蔵 `<Flash />` component                           | ❌ (= 強制ゼロ、user 任意 toast lib)                       |
| `description` / `action` / `duration` 等 shape 拡張      | ❌ (= initial 2 field のみ、痛み顕在化で revisit)          |
| schema lib agnostic な flash shape                       | ❌ (= initial は固定 shape、custom shape 需要顕在で別 ADR) |

## Rationale

### sonner mirror で書き味が最高な理由

server `c.flash.success("...")` と client `toast.success("...")` の **method 名が完全一致**することで:

```tsx
// server
c.flash.success("Post created");

// client
const f = flash();
if (f) toast[f.type](f.message); // ← type = "success" → toast.success(message)
```

`toast[f.type]` の 1 行で wire 完結。Rails の `flash[:notice]` view binding と同じ direct mapping、認知負荷ゼロ。

### `flash()` が server-side / island 両対応である理由

Hibana の ALS 基盤 ([[project_adr_0065_status]]) を経由して「現 request の Hono context」を取り出せるので、`flash()` は:

- **server-side (= layout / page) で呼ぶ**場合 = SSR 時に session から read + clear、HTML に直接焼く
- **island の中で呼ぶ**場合 = SSR 時に server 側で read + clear、island props として hydrate に流す、client mount で `effect(() => { if (f) toast[f.type](f.message); })` で sonner 呼ぶ

どちらの呼び出し path でも **read + clear は SSR で 1 回起きる**ので、cookie response header の `Set-Cookie` で session 側 flash を消す動作は一貫。reload で flash 再発火が起きない。

### `<Form>` (= ADR 0082) との相互作用

ADR 0082 の `<Form>` submit intercept + redirect follow path で、success → flash → redirect → next page の流れが自動的に成立する:

1. `<Form>` submit → fetch POST
2. server `c.flash.success("...")` + `c.redirect(...)` → 303 response
3. client fetch が redirect follow → GET next page
4. server SSR で `flash()` 呼ばれて session read + clear → partial HTML response
5. client `<Form>` が partial body を swap、新 page の island が hydrate
6. island の `flash()` 結果が effect で `toast.success(...)` 発火

server 側変更ゼロで成立、ADR 0082 partial wire / 共通祖先計算 / Frame swap / `Vary: Accept` を全て再利用。

### `c.rerender(data)` を本 ADR で扱わない理由

「同 page 再描画 + props 経由 errors 流入」は別 primitive で、flash と完全独立 (= validation failure path で errors 表示、redirect 経由 toast とは別軸)。混ぜると ADR scope 肥大、議論コスト増。別 ADR 0085 候補として保留、本 ADR は **redirect 経路通知の wire 機構**に scope 限定。

### `use` 接頭辞回避が `flash()` 命名選択になる理由

memory [[project_api_design_philosophy_object_one_spread]] + 第 27 周目 user 議論で確認: Vidro / Hibana は **React rules-of-hooks 文脈ではないので `use` 接頭辞を意図的に避ける**。`signal()` / `loaderData()` / `formControl()` 流儀と整合。`flash()` も同じ命名規則。

## Consequences

### Pros

- **F2 success path 通知問題の解消** ([[project_hibana_crud_dogfood_findings]] F2 起票材料の自然な続き)
- **sonner / shadcn / Mantine 等の任意 toast lib と統合自由** = `flash()` reader + island で `toast[f.type](f.message)` 1 行 wire
- **ADR 0082 `<Form>` flow と相乗** = success path の URL 制御 (= ADR 0082) + 通知 (= 本 ADR) が両立
- **Hibana 哲学整合** = 強制ゼロ / 薄い core / HTML-first wire / 業界 mental model (Rails / Inertia / sonner) 整合
- **fs 本命路線の dogfood 強化** ([[project_hibana_layout_direction_pending]] 暫定方針)
- **CF Workers 整合** = cookie-based でこの primary target ([[project_hibana_overview]]) の制約に乗る

### Cons / 残るリスク

- **`hono-sessions` peer dep 増** (= user install 必須、ただし opt-in、flash 使わない user は影響なし)
- **multiple flashes 未対応** (= 1 個上書き、痛み顕在化で revisit)
- **機構内蔵 UI なし** (= user が sonner 等 install + setup cost、ただし de-facto lib なら 1 行)
- **type 集合固定** (= 4 種 + default、user custom type は別 ADR)

### 既存 ADR との関係

- **ADR 0082 (`<Form>` submit intercept)**: 整合、success path で flash + redirect path が ADR 0082 partial wire 経由で自動成立、server 変更ゼロ
- **ADR 0080 (HTML swap navigation)**: 整合、`<Link>` GET 経路では flash 通常発生しない (= POST 起源)、partial response でも session read + clear は HTTP request 単位で動く
- **ADR 0079 (per-route metadata)**: 直交、影響なし
- **ADR 0065 (ALS migration)**: 依存、`flash()` reader が ALS 経由で context 取り出す
- **ADR 0057 (fw design stance)**: 整合、flash は opt-in、強制ゼロ

### 既存 memory との関係

- [[project_hibana_crud_dogfood_findings]] = F2 success path 通知の起票材料、本 ADR で fulfill
- [[project_hibana_layout_direction_pending]] = fs 本命暫定方針、本 ADR dogfood は fs 主導
- [[project_html_first_wire]] = wire は HTML default、JSON は 3 exception 該当 (= action result + 明示 data fetch + 細粒度 partial update)、flash は 「server set + client read」 wire で SSR HTML に焼く、JSON wire 例外条項に該当
- [[project_legibility_test]] = `c.flash.success("...")` は「flash の success を仕込む」と訳せる、合格
- [[project_api_design_philosophy_object_one_spread]] = `use` 接頭辞回避と method 別 API は 2 値小データ primitive 向け、object 1 個 spread 路線とは別 case
- [[project_design_north_star]] = MPA + 小 islands position 維持、SPA 化はしない、議論コストは identity の表れ

## Affected files (= 実装着地時、次 session)

### packages/hibana

- `packages/hibana/src/flash.ts` 新規:
  - `Flash` 型 (= `{ message: string, type: FlashType }`) + `FlashType` 型 (= `"default" | "success" | "error" | "warning" | "info"`)
  - `c.flash` augment (= Hono ContextRenderer 同様の `declare module "hono"` で `ContextVariableMap` or method augment)
  - `c.flash.success` / `.error` / `.warning` / `.info` method 別 attach
  - `flash()` reader (= ALS 経由で c 取り出し + session read + clear)
- `packages/hibana/src/index.ts`: `flash` reader + `Flash` / `FlashType` 型を export
- `packages/hibana/package.json`: `hono-sessions` を `peerDependencies` に追加 (= `^x.y.z` 系)
- `packages/hibana/vite.ts` or 関連 plugin: session middleware setup の dogfood support (= 必要なら)

### apps/hibana-demo-fs (= 本命 dogfood)

- `apps/hibana-demo-fs/src/app.ts`: `hono-sessions` middleware install
- `apps/hibana-demo-fs/src/routes/posts/index.tsx`: POST handler に `c.flash.success("Post created")` 追加
- `apps/hibana-demo-fs/src/routes/posts/[id]/index.tsx`: POST update handler 同様
- `apps/hibana-demo-fs/src/components/FlashToaster.island.tsx` 新規 = `flash()` reader + sonner `toast[f.type](f.message)` 呼び出し
- `apps/hibana-demo-fs/src/layouts/AppLayout.tsx`: `<Toaster richColors />` + `<FlashToaster />` 配置
- `apps/hibana-demo-fs/package.json`: `sonner` + `hono-sessions` install

### apps/hibana-demo (= 並走 sub dogfood)

- 同様の改修 (= handler-based 版でも同じ書き味が成立することの確認)

### docs/

- `docs/decisions/0084-hibana-flash-mechanism.md` 新規 (= 本 ADR)
- `docs/roadmap-hibana.md` 更新 (= ADR 0084 着地予定の追記)

## Validation (= Accepted 化までに実施)

- 既存 ADR (0001-0083) との矛盾 check (= 上記 Rationale + 既存 ADR との関係で実施済)
- 既存 memory との整合 check (= 上記 cross-check で実施済)
- user 合意取得 (= 第 27 周目 78th session で 7 軸 = 格納先 / storage / server API / multiple / client API / shape / 機構 UI、confirm 済)
- 実装着地後の dogfood smoke (= 両 app で `<Form>` submit success → flash → redirect → next page で sonner toast 表示確認)
- `feature-dev:code-reviewer` agent review (= memory [[feedback_review_in_workflow]] per、Accepted 化前 or 実装 commit 直前)

## Next steps (= Accepted 化後)

### 段階的 commit 推奨順序

1. **Phase 1**: ADR 0084 Draft 起票 + roadmap 更新 (= **本 commit**、第 27 周目で着地、実装は次 session 持ち越し)
2. **Phase 2**: `hono-sessions` peer dep 追加 + `c.flash` augment 実装 (= packages/hibana/src/flash.ts)
3. **Phase 3**: `flash()` reader 実装 (= ALS 経由、session read + clear)
4. **Phase 4**: fs 本命 dogfood (= apps/hibana-demo-fs で sonner 統合 + smoke)
5. **Phase 5**: handler 並走 sub dogfood (= apps/hibana-demo で同等 dogfood)
6. **Phase 6**: code-reviewer review + Critical fix
7. **Phase 7**: Accepted 昇格 + memory update

各 Phase は独立コミット可能。実装 phase (= 2-7) は次 session 以降。

## Revisit when

- **multiple flashes (= array で保持) の必要性顕在** — 1 個上書きで痛み出たら拡張、shape を `Flash[]` に変更 + read 順序定義
- **`description` / `action` / `duration` 等 shape 拡張需要** — sonner / shadcn の高機能 toast を flash で表現したくなったら、shape を object 拡張
- **custom type 需要顕在 (= `"loading"` / `"promise"` 等)** — type を string 自由に retreat、TypeScript literal union を緩和
- **session 以外の格納先需要 (= CF KV / Redis 等)** — `hono-sessions` の backend 切り替えで対応可、ADR 改訂不要
- **`useFlash()` 等の React 流命名要望** — 拒否継続、Vidro / Hibana の `use` 接頭辞回避は identity ([[project_api_design_philosophy_object_one_spread]])
- **機構内蔵 `<Flash />` component の必要性顕在** — toast lib 統合コストが顕在化した case、ただし sonner / shadcn の install 1 行で済むので発生条件低い、革新 case (= 新 user / 新規 lib 不採用) で別 ADR
- **`c.rerender(data)` の Accepted 化** — ADR 0085 として別議論、flash と直交、両立する想定
