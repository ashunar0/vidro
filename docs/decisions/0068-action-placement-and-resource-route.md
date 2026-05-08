# 0068 — Action 置き場と resource route (`index.server.tsx` の `action` export + `server.ts` 単独 directory)

## Status

**Proposed** — 2026-05-08 (57th session)

依存: ADR 0058 (`.server.tsx` semantics)、ADR 0066 (async server component native)、ADR 0051 (derive optimistic with intent)、ADR 0059 (validation error primitive)
関連: ADR 0067 (per-route +types codegen)、ADR 0069 候補 (`@vidro/form` opt-in pack)、memory `project_form_dogfood_2026_05_08`、memory `project_form_design_decided`

## Context

### 痛みの起点 — form dogfood 第 1+2 周目で見つかった 2 つの構造的痛み

memory `project_form_dogfood_2026_05_08` で `apps/blog` に 3 form (new / edit / delete) を実装した結果、**ADR 0066 の async server component が「page 1 ファイル完結」を実現した代償として、別の co-location 違反が発生** した。

#### 痛み点 2: action 1 個のために `server.ts` を増やす co-location 違反感

```
routes/posts/new/
├─ index.tsx       # form page (static、5-10 行)
└─ server.ts       # action only (5-10 行のために専用ファイル)
```

ADR 0066 で `index.server.tsx` を 1 ファイル完結にできるようになったが、loader 不要 + action だけほしい page では:

- `.server.tsx` 内で signal/effect 不可 (= ADR 0058)
- `submission()` は signal-based primitive
- → form を `.tsx` に倒すと、loader 不要なのに `server.ts` を action 専用に作るしかない

これは ADR 0066 起票時に見落としていた structural side effect。`server.ts` は **本来 loader + action の 2 役を束ねる co-location 単位** だったから 1 ファイル正当だったのに、loader が消えて action 1 役だけ残ると不自然に「ファイル境界」が増える。

#### 痛み点 6: resource route が機構サポート外

`packages/router/src/route-tree.ts:172`:

```ts
if (!filePath.endsWith("/index.tsx") && !filePath.endsWith("/index.server.tsx")) continue;
```

= **`server.ts` 単独 directory は route として認識されない**。`apps/blog` で `/posts/[slug]/delete/server.ts` を delete 専用 resource route として書こうとしたが 405 Method Not Allowed (= matchRoute で route 自体が無いため handleAction の match.server も null)。

回避策として `/posts/[slug]/server.ts` の同 path に倒したが、本来 REST semantics で「list の `<form action="/posts/[slug]/delete">` で submit」したい時に **path を自由に切れない** 構造的制約が残った。

### 設計議論で確定した 2-mode 構造 (memory `project_form_design_decided`)

56th session で 8 痛み点を統合議論した結果、Vidro form は **2-mode 公式サポート** で運用することに決まった:

| mode               | page file     | data 取得             | mutation 経路                                              |
| ------------------ | ------------- | --------------------- | ---------------------------------------------------------- |
| **Remix mode**     | `.tsx`        | `loaderData()`        | `server.ts` の action + `submission()` 同 path co-location |
| **AppRouter mode** | `.server.tsx` | `await db.x()` 直書き | 用途別に 3 経路 (= 後述)                                   |

**両 mode は共存可、ただし 1 page 内で混ぜない**。混ぜると magic + memory `project_legibility_test` 落ちる。mode 選択は user 判断。

#### AppRouter mode の form 戦略 = 3 経路

| 経路                                    | 場合                                       | 形                                                                                                     |
| --------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| **island form** (= default 推奨)        | rich UX 必要、JS 前提                      | `.server.tsx` shell + `.client.tsx` island、island 内で `formControl` + `fetch` で resource route 叩き |
| **同 path co-location action** (= 中間) | shell が async でも form は単純            | `.server.tsx` 内に `<form method="post">` + 同 path action export (= 本 ADR)                           |
| **primitive form** (= JS なし option)   | scale 小 / hobby / progressive enhancement | `<form method="post">` 直書き、422 は JSON page、user 工夫で server re-render も可                     |

本 ADR は **同 path co-location action** + **resource route** の機構を支える。island form 用 `formControl` primitive は ADR 0069 (`@vidro/form` opt-in pack) で扱う。

### Vidro 哲学整合 (memory cross-check)

| memory                               | 関係                                                                                   |
| ------------------------------------ | -------------------------------------------------------------------------------------- |
| `project_form_design_decided`        | 2-mode + 3 経路の機構支柱、本 ADR が「同 path co-location」と「resource route」 を着地 |
| `project_form_dogfood_2026_05_08`    | 痛み点 2 + 6 の起点記録、本 ADR で structural decide                                   |
| `project_design_north_star`          | RSC simpler 代替、AppRouter mode 完成形に必要                                          |
| `project_html_first_wire`            | resource route は HTML wire の REST semantics と整合 (= POST /posts/x/delete)          |
| `project_legibility_test`            | `index.server.tsx` の action export は「page も action も同じ場所」と読める            |
| `feedback_dx_first_design`           | dream code (`export async function action(...)` 直書き) 起点で API 逆引き              |
| `project_layer_separation_principle` | action 内 db 直叩きは softening 49th で許容、機構誘導 lint level                       |

## Options

### 論点 1: `index.server.tsx` の `action` export を router で拾うか

#### (1-A) 拾う (= **採用**)

```tsx
// routes/posts/new/index.server.tsx
import type { Route } from "./+types";
import { db } from "../../../infrastructure/db";

export default async function NewPost({ params }: Route.PageProps) {
  return (
    <form method="post">
      <input name="title" />
      <button>Create</button>
    </form>
  );
}

export async function action({ request, params }: Route.ActionArgs) {
  const fd = await request.formData();
  const post = await db.createPost({ title: String(fd.get("title")) });
  return Response.redirect(`/posts/${post.slug}`, 303);
}
```

= 1 ファイルに page (component) と action (mutation) を co-locate。Remix の自然な進化形 (= `.server.tsx` async + `action` export) で、Vidro 哲学 (HTML-first wire / legibility / 拡張子 boundary) と完全整合。

- **pros**:
  - co-location 完全 (= 痛み点 2 解消)
  - existing handleAction の `candidates` に 1 路線追加するだけで済む (= packages/router/src/server.ts:185-206)
  - user の dream code そのまま動く (= memory `feedback_dx_first_design`)
- **cons**:
  - `.server.tsx` ファイルが component + action 両方を export する形になり、責務分離派から見ると god file 寄り (= ただし 49th softening で公式推奨レベル止まり、強制ゼロ)

#### (1-B) 拾わない (= 現状維持、却下)

action は `server.ts` のみ。`.server.tsx` で action 書いても silent no-op (= 405)。

- **pros**: 機構変更ゼロ
- **cons**: 痛み点 2 解消されず、user は `server.ts` を action 1 個のために作り続ける

#### (1-C) `defineAction()` primitive 経由 (Server Actions 風、却下)

```tsx
const createPost = defineAction(async ({ request }) => { ... });
<form action={createPost}>...</form>
```

- **pros**: 関数参照を form action に bind、URL 自動生成
- **cons**: **脆弱性温床**。memory `project_form_design_decided` で user 強い preference として却下済 (= Vidro 哲学 HTML-first wire / legibility test と整合せず、magic 多すぎ)

### 論点 2: `server.ts` 単独 directory (resource route) を route として認識するか

#### (2-A) 認識する (= **採用**)

```
routes/posts/[slug]/delete/
└─ server.ts       # action only (page なし)
```

→ `POST /posts/[slug]/delete` で action 起動、`GET /posts/[slug]/delete` は 404 (page 不在)。

- **pros**:
  - 痛み点 6 解消、REST semantics で path を自由に切れる
  - HTML-first wire の島 form / cross-route POST 経路を支える (= ADR 0069 で formControl が叩く target)
  - compileRoutes 改修は filter 1 行 + servers 配列の path lookup 経路追加で済む
- **cons**:
  - GET でアクセスした user が 404 で混乱する可能性 (= dev message で「resource route は POST only」と明示)
  - matchRoute の MatchResult が「route 不在 + server あり」状態を表現する必要 (= 既存 shape の小改修)

#### (2-B) 認識しない (= 現状維持、却下)

resource route 概念を public にしない、全 action は同 path co-location 強制。

- **pros**: 機構変更ゼロ
- **cons**: 痛み点 6 解消されず、`/posts/[slug]/delete` のような REST 自然な path を切れない

#### (2-C) 専用拡張子 (`.action.ts` 等) で marker (却下)

`server.ts` ではなく `.action.ts` で resource route を表現。

- **pros**: 「これは resource route」が拡張子で即読める
- **cons**: `server.ts` (loader+action 共存) と `.action.ts` (action only) の使い分けが新たな軸として user に降ってくる、YAGNI 違反 (= server.ts 単独 directory で十分)

### 論点 3: handleAction の優先順 (= 同 path に複数 action がある時の解決順)

設計上 `index.server.tsx` の `action` export と `server.ts` の `action` export が同 directory に共存する可能性がある。

#### (3-A) `server.ts` 優先 (= **採用**)

```
routes/posts/new/
├─ index.server.tsx       # action もここに書ける
└─ server.ts              # こちらが優先
```

理由:

- `server.ts` は明示的な server-only logic file、user が意図的に置いた action は意図を尊重
- 既存 `apps/router-demo` 等の `server.ts` 経路は破壊しない
- migration path: 既存 user は `server.ts` のままで良し、新規 user は `.server.tsx` 1 ファイルでも良し

#### (3-B) `index.server.tsx` 優先

`.server.tsx` が新しい co-location の主軸なので優先。

- **cons**: 既存 user の `server.ts` action が silent に shadow される (= 大事故)、却下

### 論点 4: resource route の matchRoute shape

`MatchResult` は現状 `{ route: RouteEntry | null, server, layouts, ... }`。resource route (page 不在) では `route === null` だが server は存在する状態を表現する必要。

#### (4-A) `route === null` のまま、handleAction 側で compiled.servers から path lookup (= **採用**)

```ts
if (!match.route) {
  const resourceServer = compiled.servers.find((s) => pathMatchesPattern(s.path, url.pathname));
  if (resourceServer) candidates.push(resourceServer.load);
}
```

- **pros**: MatchResult shape 不変、既存 GET (renderPage) は route === null で 404 fallback そのまま、handleAction の小改修で済む
- **cons**: server 配列の linear scan + pattern match が handleAction 内で重複 (= 微小 overhead、route 数規模で性能影響なし)

#### (4-B) MatchResult に `resourceServer: ServerEntry | null` field 追加

shape 拡張、matchRoute で resource route も解決。

- **pros**: handleAction が単純に `match.resourceServer` を見るだけ
- **cons**: shape 増で全 MatchResult consumer に nullable 追加、YAGNI

→ **(4-A)** 採用、最小改修。

### 論点 5: GET resource route の挙動

resource route は本来 POST (mutation) only。GET でアクセスされたら:

#### (5-A) 404 fallback (= **採用**)

`renderPage` 経路は route === null で **既存挙動として** 404 not-found page を返す。resource route 用に挙動を変える必要なし、既存路線そのまま。

- **pros**: 機構変更ゼロ
- **cons**: GET で叩いた user に「resource route は POST only」と明示する dev hint が無い

#### (5-B) GET でも 405 Method Not Allowed

resource route の存在を識別して GET も明示的に弾く。

- **cons**: matchRoute で resource route を識別する new code が必要、YAGNI (= 404 で実害なし)

→ **(5-A)** 採用、404 で十分。dev console hint は将来検討。

## Decision (= 5 論点まとめ)

| #   | 論点                             | 決定                                                        |
| --- | -------------------------------- | ----------------------------------------------------------- |
| 1   | `.server.tsx` の `action` export | **拾う** (handleAction の candidates に追加)                |
| 2   | resource route                   | **認識する** (`server.ts` 単独 directory も route 扱い)     |
| 3   | 同 path 複数 action の優先順     | **`server.ts` 優先** (migration 安全側、既存 user 破壊なし) |
| 4   | resource route の MatchResult    | **`route === null` のまま handleAction で path lookup**     |
| 5   | GET resource route               | **404 fallback** (= 既存挙動そのまま)                       |

### handleAction の candidates 構築順 (= 確定形)

```ts
const candidates: ServerModuleLoader[] = [];

// 1. leaf server.ts (= 最優先、既存路線維持)
if (match.server) candidates.push(match.server.load);

// 2. resource route: server.ts 単独 directory (= 本 ADR、route 不在時)
if (!match.route && !match.server) {
  const resource = compiled.servers.find((s) => pathMatchesPattern(s.path, url.pathname));
  if (resource) candidates.push(resource.load);
}

// 3. leaf .server.tsx の action export (= 本 ADR、existing route が .server.tsx の時)
if (match.route && match.route.filePath.endsWith("/index.server.tsx")) {
  candidates.push(match.route.load);
}

// 4. layout.server.ts (= ADR 0042、既存)
for (const layout of match.layouts) {
  if (layout.serverLoad && layoutPathMatchesExact(layout.pathPrefix, url.pathname)) {
    candidates.push(layout.serverLoad);
  }
}
```

順番に load して `mod.action` を見つけたら break (= 既存ループ流用)。

### compileRoutes の filter 緩和

```ts
// before (route-tree.ts:172):
if (!filePath.endsWith("/index.tsx") && !filePath.endsWith("/index.server.tsx")) continue;

// after: server.ts は既に上で processed (line 164-167) なので、
// その directory に index.{tsx,server.tsx} が無くても servers 配列に積まれている。
// 既存 filter はそのまま (= server.ts 単独 directory は routes 配列に積まれない、
// servers 配列だけに積まれる、handleAction の candidates 経路で拾う)。
// → 実質的に compileRoutes の改修は不要、handleAction 側だけ拡張する。
```

判明: **resource route は既存 compileRoutes の挙動で `servers` 配列に積まれている**。問題は handleAction が「route がある時しか server を引かない」だったこと。handleAction の candidates 構築を本 ADR の Decision section に従って拡張すれば、それだけで resource route が動く。

→ compileRoutes 改修ゼロ、変更は handleAction の candidates 構築 + index.server.tsx の action export 解決経路追加のみ。

### Scope (= 本 ADR で扱う / 扱わない)

| 項目                                                | 本 ADR で扱う?                                                       |
| --------------------------------------------------- | -------------------------------------------------------------------- |
| `index.server.tsx` の `action` export 解決          | ✅                                                                   |
| `server.ts` 単独 directory の resource route 認識   | ✅                                                                   |
| handleAction の candidates 構築拡張                 | ✅                                                                   |
| `Route.ActionArgs` 型 (per-route +types codegen)    | ✅ (ADR 0067 で既に生成済、本 ADR で活用)                            |
| `formControl()` primitive (= AppRouter mode island) | ❌ (ADR 0069 候補で扱う)                                             |
| `<form>` cross-route POST の submission slot 整合   | ❌ (ADR 0069 で formControl が代替)                                  |
| `index.server.tsx` の `loader` export               | ❌ (`.server.tsx` は signal 不可なので loader 不要、本 ADR scope 外) |
| GET resource route の 405 明示                      | ❌ (404 fallback で十分、YAGNI)                                      |
| dev console での resource route hint                | ❌ (将来検討)                                                        |

## Consequences

### Pros

- **co-location 完全** = 痛み点 2 解消、AppRouter mode で page + action が 1 ファイル完結
- **REST semantics 自由** = 痛み点 6 解消、`/posts/[slug]/delete` のような resource route が機構サポート
- **migration 安全** = 既存 `server.ts` 経路は優先順位 1 位を維持、破壊なし
- **機構増最小** = compileRoutes 改修ゼロ、handleAction の candidates 構築拡張のみ
- **dream code 直結** = `feedback_dx_first_design` per、user が書いた `.server.tsx` 内 `action` export が動く
- **ADR 0069 への足場** = formControl が叩く resource route が機構支持される (= island form の主経路)

### Cons / 残るリスク

- **`.server.tsx` が god file 寄り** = component + action 両方 export する形は責務分離派から見ると 1 ファイル肥大化。ただし 49th softening で公式推奨レベル止まり、強制ゼロ
- **GET resource route の 404 が user 混乱を招く可能性** = dev console hint は YAGNI で defer、痛み顕在化したら別 ADR で対応
- **同 path 優先順 confusion** = `server.ts` と `index.server.tsx` の両方に action がある時の挙動を docs で明示する必要 (= server.ts 優先、`.server.tsx` の action は silent shadow)

### 既存 ADR との関係

- **ADR 0058 (`.server.tsx` semantics)**: 影響なし、`.server.tsx` 内 reactive primitive 禁止は維持。`action` named export は新たに認識追加
- **ADR 0066 (async server component native)**: 影響なし、本 ADR は同じ `.server.tsx` で named export を追加で拾う
- **ADR 0051 (derive optimistic with intent)**: 影響なし、`submission()` per-route slot は引き続き同 path co-location 用、cross-route は formControl (ADR 0069) で代替
- **ADR 0059 (validation error primitive)**: 影響なし、422 + JSON `{fields}` 規約は resource route でも `index.server.tsx` action でも同じく動く
- **ADR 0067 (per-route +types codegen)**: 直接活用、`Route.ActionArgs` が `index.server.tsx` の action 引数型として効く

### 既存 memory との関係

- `project_form_design_decided`: 2-mode + 3 経路の構造支柱、本 ADR が同 path + resource route を着地
- `project_form_dogfood_2026_05_08`: 痛み点 2 + 6 を decide、status を「✓ ADR 0068 で解決」に更新
- `project_html_first_wire`: resource route は HTML-first wire の REST semantics 自然形
- `project_design_north_star`: AppRouter mode 完成、RSC simpler 代替の form 経路完備
- `project_legibility_test`: `index.server.tsx` の action export は「page と action が同じ場所」と読める、合格

## Affected files (実装着地時)

- `packages/router/src/server.ts`: `handleAction` の candidates 構築拡張
  - resource route 経路 (= match.route なし + match.server なし時の compiled.servers lookup) 追加
  - `index.server.tsx` の action export 経路 (= match.route が .server.tsx で終わる時 match.route.load を candidates に積む) 追加
- `packages/router/src/route-tree.ts`: 改修なし (= 既存 compileRoutes が server.ts を servers 配列に積む挙動を維持、resource route 認識は handleAction 側で path lookup)
- `apps/blog/src/routes/posts/new/index.server.tsx`: dogfood、`server.ts` 削除 + `index.tsx` を `index.server.tsx` に rename + action export co-locate (= 第 3 周目で実証)
- `apps/blog/src/routes/posts/[slug]/delete/server.ts`: dogfood、resource route として復活 (= 痛み点 6 解消の実証)
- `packages/router/tests/server.test.ts` (or 該当 test): handleAction の candidates 拡張 test 追加
  - `.server.tsx` action export の解決
  - resource route (server.ts 単独 directory) の解決
  - `server.ts` 優先の確認

## Validation (= Accepted 化までに実施)

- 既存 ADR (0001-0067) との矛盾なし check (上記表で実施済)
- 既存 memory との整合 check (上記 cross-check 表で実施済)
- `feature-dev:code-explorer` agent 報告で touchpoints 確認済 (= compileRoutes 改修不要 + handleAction 拡張のみで済む確認)
- user 合意取得 (5 論点 = action export / resource route / 優先順 / MatchResult shape / GET 404)、最終 review 待ち
- `feature-dev:code-reviewer` agent review (memory `feedback_review_in_workflow` per、Accepted 化前 or 実装 commit 直前)

## Next steps (= Accepted 化後)

### 段階的 commit 推奨順序

1. **Phase 1**: handleAction の candidates 構築拡張 (= `.server.tsx` action export + resource route の path lookup)、既存 `server.ts` 経路の test pass 維持
2. **Phase 2**: 新 test 追加 (`.server.tsx` action export / resource route / server.ts 優先)
3. **Phase 3**: dogfood blog migration (= `posts/new` を `index.server.tsx` 1 ファイルに、`posts/[slug]/delete/server.ts` を resource route 復活)
4. **Phase 4**: ADR 0069 (`@vidro/form` opt-in pack) 着手、formControl が resource route を叩く形で完成

各 Phase は独立コミット可能 (= memory `feedback_collaboration_style` 流の小さな commit)。

## Revisit when

- **resource route GET 404 が user 混乱の根源化** — dev console hint / 405 明示の必要性が顕在化したら別 ADR
- **同 path 複数 action の優先順 confusion が頻発** — docs 明示で十分か、機構で warn 出すか再検討
- **`.server.tsx` の god file 化が痛み顕在** — 責務分離 lint rule (ADR 0057 機構誘導) で公式推奨レベルの誘導を強化
- **resource route で middleware (auth 等) を要求する声** — middleware ADR と統合検討
