# 0070 — Server function pattern: `serverFn()` wrapper + mode 排他路線 + 自動 fetch stub generation

## Status

**Proposed** — 2026-05-09 (58th session)

依存: ADR 0068 (action 置き場 + resource route — Pages mode で継承、AppRouter mode で部分 supersede)、ADR 0058 (`.server.tsx` semantics)、ADR 0066 (async server component native)、ADR 0067 (per-route +types codegen)、ADR 0069 (`formControl` primitive)、ADR 0065 (scope context cross async)、ADR 0051 (derive optimistic with intent — Pages mode で継承)、ADR 0059 (validation error primitive)
関連: ADR 0071 候補 (`@vidro/zod` opt-in pack)、memory `project_adr_0070_pending`、`project_layer_separation_principle`、`project_frontend_fw_3trigger_asymmetry`、`project_design_north_star`、`project_legibility_test`、`project_html_first_wire`、`project_form_design_decided`、`project_vidro_zod_pack_pending`、`project_action_phase3`

## Context

### 痛みの起点 — schema 重複と action 設計の muzumuzu

memory `project_form_dogfood_2026_05_08` の dogfood 第 3 周目 (commit 3bb68de で fix) で発見した残り痛み = **client/server で zod schema の重複定義**。`apps/blog/src/routes/posts/new/post-form.tsx` の `formControl({ schema })` と同 path の action 内 `schema.parse(input)` で同一 schema を 2 度書く構造。

memory `project_adr_0070_pending` に sleep on it 状態で残された 3 sketch (A: `defineAction({input, handler})` / C: schema.ts 分離 / D: Hono RPC `actionFor(path)`) は **どれも上位の構造的問いを残したまま**だった。58th session の議論で、より深い構造的問いが 4 つ並列に発展:

#### (i) action の 1 export 制約問題

ADR 0051 + 0068 の `action` single export は intent pattern (= form 内 `<input type="hidden" name="intent">`) で複数 mutation を判別する設計。これは `<form method="post">` HTML wire form 前提の構造で、**client から関数として呼ぶ mental model だと窮屈**:

```ts
// 現状 (ADR 0051 + 0068): 1 export + intent 分岐
export const action = async (req) => {
  const fd = await req.formData();
  const intent = fd.get("intent");
  if (intent === "create") { ... }
  if (intent === "delete") { ... }
};
```

`createPost` / `deletePost` を関数として呼ぶなら、関数名で discriminate するのが自然。`intent` で switch する理由は **HTML wire form を 1 endpoint で受ける都合** に過ぎない。

#### (ii) 3 層責務分離問題 (= memory `project_layer_separation_principle` の更新動機)

memory `project_layer_separation_principle` の 49th softening 版は「component (= server / client / universal すべて) は pure rendering only」と書いてあるが、Hono ベースの 3 層 mapping (handler → service → repository) を Vidro でどう機構誘導するかが曖昧だった。58th 議論で確定:

| 層             | Vidro での実体                                                                  | 責務                                                             |
| -------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **handler**    | `index.server.tsx` / `index.tsx` (= page component) / `*.client.tsx` (= island) | trigger 受け取り → service 呼び出し → 後処理 (navigate / render) |
| **service**    | `server.ts` の named export (= 関数置き場)                                      | business logic、validation、認可、repository 呼び出し            |
| **repository** | `infrastructure/db.ts` 等                                                       | 物理 storage 触り、純粋 I/O                                      |

これは memory `project_layer_separation_principle` の「component は pure rendering only」を **「component は handler 層、service は server.ts」** に更新する。Next.js App Router の async component メンタルモデルを取り込みつつ、db 直叩きは service 層経由で機構誘導される構造。

#### (iii) Server Actions 4 脆弱性問題

Next.js Server Actions (= `'use server'`) の脆弱性は CVE 多発、構造的理由は 4 つ:

| 要素                 | 何が起きてる                                                                      | リスク                                                     |
| -------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| **A. ID magic**      | action ごとに hash の ID 自動生成、ID 指定で実行                                  | enumeration / leak でバックドア、URL 経由の routing と分離 |
| **B. closure 送信**  | client で書いた closure capture 値が React Flight format で server に送られて実行 | client 改竄 → server 任意操作、trust boundary 曖昧         |
| **C. URL レス auth** | endpoint が無いから auth が action 単位、機構レベルで保証されない                 | 開発者が auth 書き忘れ → 権限昇格、CVE の主因              |
| **D. Flight format** | React 内部 IPC を wire に流出                                                     | parse 攻撃面、debug 困難、HTML-first 哲学と真逆            |

これら全部を踏まずに「`await createPost(data)` の plain function call mental model」を取れるか、が本 ADR の core。

#### (iv) 3-trigger 非対称性問題 (= memory `project_frontend_fw_3trigger_asymmetry`)

frontend FW は trigger が 3 種類 (URL change / user event / render mount)、backend (= 1 trigger HTTP request) と違って構造的非対称。memory `project_frontend_fw_3trigger_asymmetry` の Path 1 (= 型貫通で痛みを吸収) を具体化する 1 形式が必要:

| trigger                    | 既存 Vidro の 1 形式      | AppRouter mode で本 ADR が確定する形                       |
| -------------------------- | ------------------------- | ---------------------------------------------------------- |
| URL change (declarative)   | loader (= ADR 0049)       | `await getPost(slug)` を server component から呼ぶ         |
| user event (imperative)    | action (= ADR 0051)       | `await createPost(input)` を island から呼ぶ (= stub 経由) |
| render mount (declarative) | `resource()` (= ADR 0064) | 既存維持                                                   |

3 trigger 全てが「server function を `await` で呼ぶ」1 形式に collapse、書き心地統一。

### 北極星 = 「読んで日本語に訳せる」+ 「想定外が生えない」

memory `project_legibility_test` の基準を 1 段拡張:

> **「user が想定したものと等価なら boilerplate 削減 magic 許容、想定外が生えたら却下」**

`await createPost(data)` を見た user は「create post を呼ぶ、結果を待つ、内部で fetch + JSON parse」を想定する。これは想定範囲内、boilerplate 削減 OK。

Server Actions が踏み越えた 4 要素 (= Flight / ID magic / URL 隠蔽 / closure) は **どれも user の想定外**。Vidro は踏まない。

### Vidro 哲学整合 (memory cross-check)

| memory                                   | 関係                                                                         |
| ---------------------------------------- | ---------------------------------------------------------------------------- |
| `project_adr_0070_pending`               | 起票元、sleep on it 状態の 3 sketch を 58th session の構造的整理で解消       |
| `project_layer_separation_principle`     | component pure rendering → handler 層に update、3 層 mapping 機構誘導        |
| `project_frontend_fw_3trigger_asymmetry` | Path 1 の 1 形式を具体化、`await fn()` 統一                                  |
| `project_design_north_star`              | RSC simpler 代替の核心ピース、hobby/personal 規模感と整合                    |
| `project_legibility_test`                | 「想定したものと等価なら magic 許容」原則を本 ADR で言語化                   |
| `project_html_first_wire`                | AppRouter mode の wire は JSON、HTML-first 例外条項 (= action result) に該当 |
| `project_form_design_decided`            | 共存路線 (= 1 page 混ぜない) → 排他路線 (= project 単位選択) に update       |
| `project_vidro_zod_pack_pending`         | 起票 trigger 達成、ADR 0071 と連動着地                                       |
| `project_action_phase3`                  | ADR 0051 intent pattern は Pages mode で継承、AppRouter mode で superseded   |
| `feedback_dx_first_design`               | dream code (`await createPost(data)`) 起点で API 逆引き                      |

## Options

### 論点 1: server function の export 形

#### (1-A) `server.ts` / `*.server.tsx` で named export を自由に並べる + `serverFn()` wrapper 採用 (= **採用**)

bundler が server function として認識する場所は **2 つの拡張子規約** で表明する:

1. **`server.ts`** (= named file): server function 専用 file、named export として並べる
2. **`*.server.tsx`** (= named extension): page component (= default export) と同居して named export で書く、1 file 完結

両方とも server bundle のみに含まれる物理判定 (= 拡張子で実行場所を表明する Vidro 哲学整合)。**universal `.tsx` / `.client.tsx` 内の inline `serverFn(...)` は build error** (= 「書いた場所と実行場所のズレ」を bundler 解析で吸収する magic を Vidro は採らない)。

```ts
// routes/posts/[slug]/edit/server.ts
import { z } from "zod";
import { validator } from "@vidro/zod";
import { db } from "@/infrastructure/db";

export const updatePostSchema = z.object({ title: z.string().min(1), body: z.string().min(1) });
export type UpdatePostInput = z.infer<typeof updatePostSchema>;

export const updatePost = serverFn(
  validator(updatePostSchema),
  async (c, slug: string, input: UpdatePostInput) => {
    return db.posts.update(slug, input);
  },
);
```

```tsx
// routes/posts/[slug]/edit/edit-form.tsx (= universal island)
import { updatePost } from "./server";

const handleSubmit = async (data) => {
  const post = await updatePost(slug, data); // ← bundler が stub 化
  navigate(`/posts/${post.slug}`);
};
```

規模 XS の 1 file 完結ケースでは `*.server.tsx` の named export が使える:

```tsx
// routes/posts/new/index.server.tsx (= 1 file 完結)
import { serverFn } from "@vidro/router";
import { validator } from "@vidro/zod";
import { db } from "@/infrastructure/db";

export const createPostSchema = z.object({ title: z.string().min(1), body: z.string().min(1) });

// service 層 (= named export = server function)
export const createPost = serverFn(validator(createPostSchema), async (c, input) => {
  return db.posts.insert(input);
});

// handler 層 (= default export = page component)
export default async function NewPost() {
  return <PostForm />;
}
```

- **pros**:
  - 関数名で discriminate (= intent pattern 不要、ADR 0051 の muzumuzu 解消)
  - context (`c`) 引数注入で legibility 高 (= Hono / TanStack Start 慣習流用)
  - middleware 引数で per-function 防御 (= Server Actions 流の auth 書き忘れ事故を function 単位で防ぐ)
  - read 系 (`getPost`) と write 系 (`createPost`) で書き心地統一 (= 3-trigger Path 1 着地)
  - **`*.server.tsx` の named export 認識**で規模 XS の 1 file 完結体験 (= 2 file 強制を避ける)
  - **物理判定で magic ゼロ** (= 拡張子で server/client を表明、bundler は AST 切り出し不要)
- **cons**:
  - wrapper 学習要 (= ただし TanStack Start `createServerFn` / Hono `app.post(mw, h)` 慣習)
  - bundler が export 種別を判定する必要 (= async function or `serverFn(...)` 戻り値)
  - `*.server.tsx` は「page + service 集」の多重責務 (= 規模 M+ で `server.ts` 分離を user 判断で誘導)

#### (1-B) `action` single export + intent pattern (= ADR 0051 現状維持)

→ AppRouter mode では却下 (= mental model ズレ、ただし Pages mode では継承)。

#### (1-C) `defineAction({ input, handler })` wrapper (= memory `project_adr_0070_pending` の Sketch A 元案)

→ 却下。input + handler の 2 引数構造は middleware chain を表現しにくい、Hono `app.post(mw, h)` 慣習から外れる。

#### (1-D) `'use server'` directive (= Next.js Server Actions 流)

→ 却下。memory `project_html_first_wire` 違反 + Server Actions 4 脆弱性踏襲リスク。

→ **(1-A) 採用**。

### 論点 2: mode 排他路線 vs 共存路線

#### (2-A) project 単位で 1 mode 選択 = 排他路線 (= **採用**)

`vidro.config.ts` に `mode: "pages" | "app"` field を追加、create-vidro CLI で初期選択。Next.js (app/ vs pages/) と同じモデル。

| mode               | page file                    | `server.ts` の export                                            |
| ------------------ | ---------------------------- | ---------------------------------------------------------------- |
| **Pages mode**     | `index.tsx` + `loaderData()` | `loader` / `action` (= ADR 0049 + 0051 + 0068 そのまま継承)      |
| **AppRouter mode** | `index.server.tsx` (async)   | `getPost` / `createPost` 等 (= 自由 named export、本 ADR で確定) |

- **pros**:
  - 設計シンプル (= mode 切り替え判定が project レベルで固定、page ごとの判定不要)
  - URL 衝突問題が **構造的にゼロ** (= 論点 4 の Z-1 採用が成立)
  - user 認知負荷低 (= 「これ Pages? AppRouter?」を file 開くたびに迷わない)
  - Vidro hobby/personal 規模感 (= memory `project_design_north_star`) と整合、「project 開始時に 1 個選んで使う」が hobby 文化と一致
  - `server.ts` の意味が project 内で完全固定
- **cons**:
  - 後から mode 変更が大変 (= ただし Next.js も同じ、scale 小なら書き直し許容)
  - 1 project 内で AppRouter / Pages 混在不可

#### (2-B) 1 page 内で混ぜない、project 内では共存 (= memory `project_form_design_decided` 旧設計)

→ 却下。共存ロジックは scale 大向けの過剰柔軟性、Vidro identity と整合しない。

→ **(2-A) 採用**、memory `project_form_design_decided` を update。

### 論点 3: AppRouter mode での wire 機構

#### (3-A) bundler 自動 fetch stub generation + 3 条件 (= **採用**)

bundler が `import { createPost } from "./server"` を、生成された fetch stub に置換:

```ts
// bundler 自動生成 (= client bundle 内、user は通常見ない、ただし inspect 可能)
export const createPost = async (input) => {
  const res = await fetch("/posts/new/createPost", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new ServerFnError(res);
  return res.json();
};
```

3 条件:

1. **inspect 可能** = `vp build --inspect-stub` 等のコマンドで生成内容を表示できる、隠さない
2. **URL deterministic** = file path 由来、hash ID / random は生成しない (= 論点 4 Z-1)
3. **middleware 通常通り** = 自動除外しない、stub の URL も普通の POST として middleware を通す (= Next.js 流の auto-bypass を採らない)

- **pros**:
  - user が手書きしたら同じ shape の fetch、boilerplate 削減のみ、想定外なし
  - Server Actions 4 脆弱性を構造的に削る:
    - Flight format 不採用 (= 普通の JSON wire、memory `project_html_first_wire` の例外条項該当)
    - ID magic 不採用 (= URL は file path 由来、enumerate しても定義済 server function のみ = 普通の HTTP route と同 risk surface)
    - URL 透過 (= middleware が普通に kick、user の routing 認識と機構が一致)
    - closure 拒否 (= input は serializable のみ、関数型 arg は build error)
- **cons**:
  - bundler 拡張要 (= server.ts 内 export 種別判定 + stub generation + closure capture build error)
  - ただし複雑性は bundler 側、user 側 syntax は最もシンプル

#### (3-B) 明示的 RPC client (= Hono RPC / TanStack Router 流)

```tsx
import { rpc } from "@vidro/rpc";
import type * as fns from "./server";
const post = await rpc<typeof fns.createPost>("./server#createPost", data);
```

→ 却下。`await createPost(data)` の plain function call mental model を捨てる、user は tRPC を直接使えば良い (= FW 機構として持つほどではない)。

#### (3-C) 完全手書き fetch + 型のみ共有 (= memory `project_adr_0070_pending` の Sketch C 元案)

→ 却下。boilerplate 重複 (= 各 form で fetch URL / method / body を user が書く)、北極星「read/write 統一 `await fn()`」と矛盾。

→ **(3-A) 採用**。

### 論点 4: URL 命名スキーム + server function 配置

server function を **どこに置けるか** と **URL をどう生成するか** は連動する。58th session 議論で「routes/ 必須は強制せず、ファイル名で識別、場所自由」に着地。

#### (4-A) ファイル名識別 + URL = src 相対 path (routes/ のみ strip) (= **採用**)

bundler は **`server.ts` / `*.server.tsx` のファイル名規約のみ**で server function 集を識別する。場所縛り (= routes/ 必須) は強制しない:

```
src/
├─ routes/posts/[slug]/edit/server.ts      → POST /posts/[slug]/edit/updatePost  (routes/ strip)
├─ features/posts/server.ts                → POST /features/posts/createPost     (src 相対)
└─ api/upload/server.ts                    → POST /api/upload/uploadFile         (src 相対)
```

URL 生成規則:

| 配置                                                          | URL                                                                     |
| ------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `src/routes/{path}/server.ts` の `fn`                         | `/{path}/fn` (= routes/ strip して 1:1)                                 |
| `src/routes/{path}/*.server.tsx` の named export `fn`         | `/{path}/fn` (= 同上)                                                   |
| `src/{path}/server.ts` の `fn` (= routes/ 外)                 | `/{path}/fn` (= src/ strip、internal directory 名がそのまま URL に出る) |
| `src/{path}/*.server.tsx` の named export `fn` (= routes/ 外) | `/{path}/fn` (= 同上)                                                   |

- file path の dynamic segment (= `[slug]`) はそのまま URL の path param に
- 関数名は path の最後に suffix
- prefix なし (= `_fn` / `_action` / `_rpc` 等の機構由来名 space 不採用)
- **hash ID 不採用** (= TanStack Start も Server Actions も hash 派、Vidro は file path 1:1 を哲学的選択)

論点 2-A (mode 排他) 採用により Pages mode action (= 同 path POST) との衝突は **構造的にゼロ**。

#### 公式推奨配置パターン (= 公式 doc で示すレベル、強制ゼロ)

| パターン                                    | 例                             | trade-off                                                                                              |
| ------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| **route-bound** (= 規模 XS / page と密結合) | `routes/posts/new/server.ts`   | ◯ middleware 自動継承、URL = `/posts/new/createPost`                                                   |
| **API folder** (= Next.js 慣習)             | `src/api/upload/server.ts`     | ◯ 「API は API、page は page」分離、URL = `/api/upload/uploadFile`、middleware は function 単位        |
| **Feature-based**                           | `src/features/posts/server.ts` | ◯ 機能単位凝集 (CRUD まとめて 1 file)、URL = `/features/posts/createPost`、middleware は function 単位 |

どれも合法、user/app 判断。FW は強制せず、`routes/` 内配置を「**安全 default の bonus がある選択**」として doc 誘導。

- **pros**:
  - **場所自由** (= routes/ 必須を強制しない、Feature-based / API folder 等 user 流派の選択を尊重)
  - prefix なし = 「余計なものが生えない」原則 (= 論点 3-A 3 条件) と最強整合
  - file path 1:1 = URL 見て file 即逆引き、predictable
  - **「URL 透過」哲学維持** (= memory `project_html_first_wire` 整合、Hono `app.post('/posts', h)` 直系)
  - **routes/ 内配置は path 階層 middleware 自動継承の bonus を得る** (= 論点 5)
  - hash ID と違って **URL = file 1:1 で middleware 機構が path matcher で連動可能** (= TanStack/Server Actions が持てない構造)

- **cons**:
  - routes/ 外配置時、internal directory 名 (= `features/` / `src/` 階層名) が URL に出る (= user が嫌なら `routes/api/...` 等の routes/ 内配置を選べる、user 判断で回避可能)

#### (4-B) Z-2: 隔離 namespace (`/_fn/posts/[slug]/edit/updatePost`)

→ 却下。論点 2-A で衝突問題が消えた以上、prefix の意義がなくなる (= 共存路線維持なら採用候補だった)。

#### (4-C) Z-3: 同 path + body 内で関数名 discriminate

→ 却下。同 URL で middleware が「これは Pages mode action」と思って auth 走らせた後、機構が「いや AppRouter mode server function」として違う handler に dispatch する **二重 dispatch** が user 想定外。

#### (4-D) Z-4: hash ID (= TanStack Start `prevent file path leakage` 流)

→ 却下。memory `project_html_first_wire` (= URL 透過) 違反。さらに **hash ID は path 構造を持たないため middleware 機構と紐付かない** (= TanStack も declarative attach か function 単位 wrapper でしか守れない、Server Actions は手書き必須)。Vidro は file path 1:1 で **path 階層 middleware 自動継承を機構成立**させる路線。

「URL leak は obscurity 派の懸念で、Vidro は authorization で守る」が哲学的立場 (= memory `project_legibility_test` 整合、現代 web security の主流派)。

→ **(4-A) 採用**。

### 論点 5: middleware 配置 (= self-managed default + routes/ 配置 bonus)

公式 stance: **middleware は self-managed が default** (= Hono 流の透明性継承、書き忘れ責任 user)。**ただし routes/ 配置時は path 階層構造の副産物として `middleware.ts` が機構自動継承される** = 「強制」ではなく「**配置による bonus**」。

#### (5-A) Hono 流 self-managed + routes/ 配置 bonus (= **採用**)

##### default (= self-managed): function 単位 wrapper で書く

```ts
// features/posts/server.ts (= routes/ 外、middleware 継承なし)
import { serverFn } from "@vidro/router";
import { authMw } from "@/middleware/auth";

export const createPost = serverFn(authMw, async (c, input) => {
  const user = c.get("user"); // ← function 単位 middleware が set
  return db.posts.insert({ ...input, authorId: user.id });
});
```

→ Hono の `app.post('/posts', authMw, handler)` 直系。書き忘れたら auth 通らない、user 責任。

##### bonus (= routes/ 配置時): directory `middleware.ts` 自動継承

```
routes/posts/
├─ middleware.ts                       ← /posts/* に効く (= 全 server function に自動 apply)
│    export const middleware = [authMw];
│
└─ new/server.ts
     export const createPost = serverFn(rateLimit(), async (c, input) => {
       const user = c.get("user");        // ← path 階層 middleware で set 済
       return db.posts.insert({ ...input, authorId: user.id });
     });
```

URL = `/posts/new/createPost` が path 構造を持つので、**middleware が `/posts/*` matcher で機構連動**。これは file path 1:1 を選んだ副産物、TanStack/Server Actions の hash ID 派が構造的に持てない bonus。

##### 配置別の挙動表

| 配置                                            | 自動継承                                                   | function 単位 wrapper         |
| ----------------------------------------------- | ---------------------------------------------------------- | ----------------------------- |
| `routes/{path}/server.ts` または `*.server.tsx` | ✅ 同 directory + 親 directory の `middleware.ts` を chain | ✅ `serverFn(mw, h)` 引数     |
| routes/ 外 (例: `features/` / `api/`)           | ❌ なし                                                    | ✅ `serverFn(mw, h)` 引数のみ |

##### 哲学的位置

memory `project_fw_design_stance` (= 強制せず機構誘導 + 公式推奨) の middleware 文脈具体化:

- **default は安全側** (= 公式推奨 = routes/ 内配置時 `middleware.ts` 自動継承 bonus)
- **外したいなら外せる** (= routes/ 外も合法、function 単位 wrapper で防御責任を user が負う)
- **強制ゼロ** (= routes/ 必須を強制しない、scale-aware に user が選ぶ)

これは **backend FW (= Hono) の透明性 + frontend FW の安全 default** のハイブリッド。設計書 5 哲学の「Hono 的透明性 + AI-native 規約」同居の middleware 文脈実現。

- **pros**:
  - **self-managed default** = Hono 流透明性、user 認知負荷低 (= 「書いたものだけ動く」)
  - **routes/ 配置 bonus** = path 階層 middleware 自動継承で安全 default が機構成立
  - **両立可能** = TanStack/Server Actions が持てない構造的成果 (= URL = file path 1:1 の副産物)
  - Hono `app.use(mw).post(mw, h)` メンタルモデル直系
  - memory `project_fw_design_stance` 「強制せず機構誘導 + 公式推奨」具体化
- **cons**:
  - routes/ 外配置時の middleware 書き忘れリスクは user 責任 (= ただし Hono と同水準、Server Actions より構造的に安全)

#### (5-B) function wrapper 強制 (= TanStack Start 流、route 単位なし)

→ 却下。routes/ 配置時の path 階層 bonus を放棄する、Vidro が file path 1:1 を選んだ意義が薄れる。

#### (5-C) route 単位 強制 (= routes/ 必須前提、function wrapper なし)

→ 却下。場所縛り (= routes/ 必須) を user に強制する、memory `project_fw_design_stance` 違反。

→ **(5-A) 採用**、self-managed default + routes/ 配置 bonus のハイブリッド。

### 論点 6: context (`c`) の API surface

Hono context のサブセットを採用、server function の特殊性で不要なものは引く。

#### 採用 API:

| API                                               | 用途                                                                  |
| ------------------------------------------------- | --------------------------------------------------------------------- |
| `c.req.url` / `c.req.headers`                     | URL, cookies, auth header, referer 等の request meta                  |
| `c.req.query("foo")`                              | URL query string (= dynamic param とは別経路)                         |
| `c.get("key")` / `c.set("key", v)` / `c.var.user` | middleware 間値受け渡し (= Hono と同じ)                               |
| `c.env`                                           | Cloudflare bindings (D1, KV, R2 等)、既存 `getRequestEnv<T>()` を統合 |
| `c.executionCtx.waitUntil()`                      | Cloudflare execution context、background work                         |

#### 不採用 API:

| API                                  | 不採用理由                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------ |
| `c.req.json()` / `c.req.formData()`  | input は wrapper が引数で渡す、`c` 経由は冗長                                  |
| `c.req.param("slug")`                | dynamic param は引数 inject (= 論点 7)、`c` 経由は冗長                         |
| `c.json()` / `c.text()` / `c.html()` | return value がそのまま JSON wire 化、response builder 不要                    |
| `c.redirect("/...")`                 | server function は値返すモデル、redirect は別 throw 機構が筋 (= Open Question) |

#### 統合効果:

memory `project_adr_0066_status` の `getRequestEnv<T>()` (= 852715b) は **`c.env` に統合**される。AppRouter mode の server component から呼ぶ server function は、`c` 引数経由で env 取得 (= ALS magic を引数注入に置換、legibility 上昇)。

- **pros**:
  - Hono メンタルモデル流用、user 学習コスト低 (= 既に Hono 知ってる user は読める)
  - server function 特化で冗長 API が削れる (= response builder と body parser を外す)
  - `c.env` 統合で ALS dependency 軽減
- **cons**:
  - Hono c とは API subset、完全互換ではない (= ただし `c.req.url` / `c.get` 等の主要 API は同形)

### 論点 7: dynamic route param と引数の対応

#### (7-A) 位置引数 = file path の dynamic segment N 個 → 引数の最初の N 個 (= **採用**)

```ts
// routes/posts/[slug]/edit/server.ts ([slug] 1 個)
export const updatePost = serverFn(async (c, slug: string, input: UpdatePostInput) => { ... });
// client: await updatePost(slug, input)

// routes/posts/[slug]/comments/[commentId]/server.ts (2 個)
export const updateComment = serverFn(
  async (c, slug: string, commentId: string, input: UpdateCommentInput) => { ... }
);
// client: await updateComment(slug, commentId, input)

// dynamic なし
// routes/posts/new/server.ts
export const createPost = serverFn(async (c, input: CreatePostInput) => { ... });
// client: await createPost(input)
```

ルール: file path の `[xxx]` の数 N → 引数の最初の N 個が path param、残りが body (= JSON serialize)。

- **pros**:
  - 普通の TypeScript 関数呼び出し感覚、分割代入なし
  - client/server で同じ signature (= user は 1 個の関数を書く、両側同じ)
  - 引数の意味が file path から推測可能 (= `[slug]` あるなら最初の引数が slug、自然)
  - REST mental model (= axios/fetch wrapper 書く人の自然な期待) と一致
- **cons**:
  - bundler が file path 解析して引数振り分け (= 機構複雑性、ただし deterministic)

#### (7-B) 分割代入で merge object (= `(c, {slug, ...input})`)

→ 却下。普通の関数呼び出し感覚から外れる、boilerplate 増える。

#### (7-C) `c.req.param("slug")` で取得

→ 却下。client から見ると `await updatePost(input)` だけで slug が見えない、 mental model ズレ。

→ **(7-A) 採用**。

### 論点 8: schema 統合 (= 元々の起票 trigger)

#### (8-A) `@vidro/zod` opt-in pack の `validator(schema)` middleware (= **採用**、ADR 0071 で詳細)

```ts
// server.ts
export const createPostSchema = z.object({ title: z.string().min(1), body: z.string().min(1) });
export type CreatePostInput = z.infer<typeof createPostSchema>;

export const createPost = serverFn(
  validator(createPostSchema), // ← schema を middleware として
  async (c, input: CreatePostInput) => {
    // input は parse 済 + typed
    return db.posts.insert(input);
  },
);
```

```tsx
// post-form.client.tsx (= island)
import { createPost, createPostSchema } from "./server";
import { formControl } from "@vidro/form";

const f = formControl({ schema: createPostSchema }); // ← 同 schema 再利用
const handleSubmit = async (data) => {
  const post = await createPost(data);
  navigate(`/posts/${post.slug}`);
};
```

key 機構:

- **schema は server.ts 内で定義** (`export const createPostSchema = ...`)
- **bundler は async function / `serverFn(...)` 戻り値 だけ stub 化、データ export はそのまま client bundle に含める** (= zod は isomorphic、schema runtime も client に乗る)
- **client form では同 import で `formControl({ schema })` 再利用** = 重複ゼロ
- server 側は `validator(schema)` middleware で input parse、failure 時 422 自動応答 (= ADR 0059 規約踏襲)

- **pros**:
  - ADR 0070 元々の起点 (= schema 重複) を構造的に解消、ファイル 1 個増えない (= co-location 維持)
  - Hono `@hono/zod-validator` メンタルモデル直系
  - 「想定外が生えない」原則整合 (= schema は普通の export、import すれば使える、validator は wrapper の middleware で見える)
- **cons**:
  - bundler の export 種別判定が必要 (= 関数か非関数かで処理分岐、ただし論点 3-A の機構で既に必要)

#### (8-B) schema 別ファイル (= memory `project_adr_0070_pending` の Sketch C 元案)

→ 却下。ファイル 1 個増、命名規約必要、co-location 違反。

#### (8-C) `defineAction({ input, handler })` で schema bundle (= Sketch A 元案)

→ 却下。論点 1-C で却下済、wrapper 形が middleware chain を表現しにくい。

→ **(8-A) 採用**。

## Decision (= 8 論点まとめ)

| #   | 論点                      | 決定                                                                                                                                                                                                                                                  |
| --- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | server function export 形 | **`server.ts` / `*.server.tsx` の named export + `serverFn(...mw, handler)` wrapper** (関数名で discriminate、context 引数注入、per-function middleware、`*.server.tsx` で 1 file 完結 OK、universal `.tsx` / `.client.tsx` 内 inline は build error) |
| 2   | mode                      | **project 単位で排他選択** (`vidro.config.ts` の `mode: "pages" \| "app"`、create-vidro CLI で初期選択)                                                                                                                                               |
| 3   | AppRouter mode の wire    | **bundler 自動 fetch stub generation + 3 条件** (inspect / deterministic / middleware kick)                                                                                                                                                           |
| 4   | URL 命名 + 配置           | **ファイル名識別 (= 場所自由化) + URL = src 相対 path (routes/ 内のみ strip)** (`routes/posts/new/server.ts` の `createPost` → `/posts/new/createPost`、`features/posts/server.ts` の `createPost` → `/features/posts/createPost`、hash ID 不採用)    |
| 5   | middleware                | **self-managed default + routes/ 配置 bonus** (= Hono 流の `serverFn(mw, h)` を default、routes/ 内配置時は path 階層 `middleware.ts` を機構自動継承)                                                                                                 |
| 6   | context API               | **Hono c subset** (response builder と body parser を引く、`c.env` で `getRequestEnv` 統合)                                                                                                                                                           |
| 7   | dynamic param             | **位置引数** (= file path dyn segment N 個 → 引数の最初の N 個、残りが body)                                                                                                                                                                          |
| 8   | schema 統合               | **`@vidro/zod` opt-in pack の `validator(schema)` middleware** (ADR 0071 で詳細)                                                                                                                                                                      |

### Scope (= 本 ADR で扱う / 扱わない)

| 項目                                                            | 本 ADR で扱う?                                                     |
| --------------------------------------------------------------- | ------------------------------------------------------------------ |
| `serverFn()` factory + middleware chain + handler signature     | ✅                                                                 |
| `server.ts` named export 認識 + bundler stub generation (= Z-1) | ✅                                                                 |
| mode 排他 (= `vidro.config.ts` mode field、project 単位選択)    | ✅                                                                 |
| route 単位 middleware (= directory `middleware.ts` 認識)        | ✅                                                                 |
| context (`c`) API surface (= Hono c subset)                     | ✅                                                                 |
| dynamic param 位置引数 inject                                   | ✅                                                                 |
| Pages mode の現状維持 (= ADR 0049 / 0051 / 0068 そのまま)       | ✅ (= 何もしない、明示的に「変更なし」と確定)                      |
| `@vidro/zod` `validator(schema)` middleware 詳細                | ❌ (= ADR 0071 で起票)                                             |
| closure capture 拒否の具体実装 (= build error vs lint warn)     | △ Open Question                                                    |
| `c.redirect()` 相当の必要性                                     | △ Open Question                                                    |
| create-vidro CLI での mode 選択 UX                              | ❌ (= memory `project_app_scaffolding_strategy`、CLI 実装時に決定) |
| 既存 apps/blog の AppRouter mode migration                      | ❌ (= dogfood Phase 7、本 ADR Accepted 化後の段階実装)             |

## Rationale

### 北極星 = 「想定外が生えない」が判断軸

`await createPost(data)` の見た目は **plain function call**。user が想定するのは「fetch して JSON parse」、これは論点 3-A の自動 stub と等価。

Server Actions が脆弱な構造的理由は magic 自体ではなく、**magic が user の想定を超えたところ**にある:

- Flight format → user は普通の JSON を想定、独自 wire は想定外 → Vidro は普通の JSON
- ID magic → user は URL ベース routing を想定、hash ID は想定外 → Vidro は file path 由来 URL
- URL 隠蔽 → user は middleware が普通に動くと想定、auto-bypass は想定外 → Vidro は普通の HTTP route
- closure 送信 → user は arg を value として送ると想定、closure capture は想定外 → Vidro は build 時拒否

memory `project_legibility_test` の「日本語に訳せるか」基準を、**生成コード側にも拡張**したのが本 ADR の核。

### mode 排他路線が Vidro identity と整合する理由

memory `project_design_north_star` の北極星 = RSC simpler 代替 + hobby/personal 規模感。

共存路線 (= 1 page 内で混ぜない、project 内では共存) は、scale 大向けの過剰柔軟性。hobby/personal だと「project 開始時に 1 個選ぶ」が自然 (= Next.js の app/ vs pages/ 選択モデル)。

memory `project_fw_design_stance` の「強制せず機構誘導」は、mode 排他でも反しない: user は project 開始時に判断、後は機構が誘導。

副次効果として、Z-1 採用 (= 論点 4-A) が成立、URL 衝突問題が **構造的にゼロ** になる。共存路線維持なら Z-2 (= prefix 隔離) に倒れていた。

### TanStack Start / Server Actions との比較で見える Vidro identity

3 FW の middleware 機構を比較すると、Vidro 案の構造的差異が浮かぶ:

| FW                         | URL 生成                                                    | route 階層 middleware                                                                                                         | function 単位                                                                         |
| -------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **Next.js Server Actions** | hash ID (= `/_actions/abc123`)                              | **無し** (= 機構紐付かず、毎関数頭で `await auth()` 手書き必須、CVE 主因)                                                     | wrapper なし                                                                          |
| **TanStack Start**         | hash ID (= `prevent file path leakage` を公式 default 理由) | **無し** (= server route と server function は 2 系統独立、`createFileRoute server.middleware` は server function に効かない) | あり (= `createServerFn().middleware([])`) + global (= `start.ts functionMiddleware`) |
| **Vidro 案**               | **file path 1:1**                                           | **あり** (= directory `middleware.ts` を path matcher で自動継承)                                                             | あり (= `serverFn(mw, h)`)                                                            |

Next.js 公式 doc (= `data-security.mdx`) は "Page-level checks do not protect Server Actions; always perform authentication checks within the action body" と明言。これが Server Actions の CVE 主因。TanStack Start も hash ID 派なので構造的に同じ問題を抱え、function 単位 wrapper か global で attach 必須。

**Vidro だけが「URL = file path → path 階層 middleware 自動継承」という構造的成果を持つ**。これは file path 1:1 を選んだ副産物、TanStack/Server Actions が hash ID を選んだ瞬間に放棄した構造。

### security through obscurity ではなく authorization で守る

TanStack Start 公式 doc が掲げる "prevent file path leakage" は **URL を隠して守る** 派の発想 (= obscurity)。Vidro はこれを採らない:

- URL 公開しても **auth + RBAC で守られる**前提 (= 現代 web security 主流派)
- URL 透過 = Hono `app.post('/posts', h)` 直系、debug / AI legibility 最強
- memory `project_html_first_wire` の URL 透過哲学整合
- memory `project_legibility_test` 「URL 見て file 即逆引き」整合

「URL 隠せば守れる」発想は obscurity に倒れる、Vidro は **authorization で守る** 立場。

### Hono 流 self-managed + routes/ 配置 bonus というハイブリッド stance

memory `project_fw_design_stance` (= 強制せず機構誘導 + 公式推奨) の middleware 文脈具体化:

| stance                                    | 例                                        | Vidro での実現                                                 |
| ----------------------------------------- | ----------------------------------------- | -------------------------------------------------------------- |
| **完全 Hono 流 (= 自由 + self-managed)**  | Hono `app.post(mw, h)`                    | routes/ 外配置 = function 単位 wrapper のみ、書き忘れ責任 user |
| **完全 Rails 流 (= 強制 + 安全 default)** | Rails CSRF protection 等                  | (Vidro は採らない、強制ゼロ)                                   |
| **Vidro hybrid**                          | self-managed default + routes/ 配置 bonus | routes/ 内 = path 階層自動継承、外 = self-managed              |

→ Hono の透明性を base にして、**「routing system に乗ったら副産物として middleware 階層継承 bonus が付く」** という構造。「強制」ではなく「**配置による恩恵**」。

これは backend FW (= Hono) の透明性 + frontend FW の安全 default の両方を **strain なく同居** させる、Vidro 独自の middleware 哲学。Server Actions が踏み外し、TanStack が片寄せた場所で、Vidro は両立を構造で実現する。

### 場所縛りを強制しない判断 (= 58th session 議論の核)

ADR 起草時 (= 58th session 前半) は routes/ 必須前提だったが、議論で「**common API / Feature-based 配置等、app によって正解が違う**」が浮かび、強制を撤廃した:

- routes/ 必須は **scale 大 / API 重視 app では制約**
- Feature-based 配置は CRUD 凝集が綺麗
- API folder (= Next.js api/ 慣習) も自然
- → **どれを正解とするかは user/app 判断**

memory `project_design_north_star` (= hobby/personal 規模感) で見ても scale-aware 整合: 規模 XS は routes/ 内、規模 M+ で features/ や api/ への分離が自然。

memory `project_legibility_test` 「想定外を生やさない」も整合: routes/ 内 = 「path 階層 middleware が効く」と user 想定 → 機構もそう動く / routes/ 外 = 「middleware 継承なし、function 単位で書く」と user 想定 → 機構もそう動く。**どちらの選択も想定通り**。

### 3-trigger 非対称性 (memory `project_frontend_fw_3trigger_asymmetry`) の Path 1 着地

| trigger                    | AppRouter mode 1 形式 (本 ADR で確定)                      |
| -------------------------- | ---------------------------------------------------------- |
| URL change (declarative)   | `await getPost(slug)` を server component から呼ぶ         |
| user event (imperative)    | `await createPost(input)` を island から呼ぶ (= stub 経由) |
| render mount (declarative) | `resource()` (= 既存 ADR 0064 維持)                        |

3 trigger 全てが「server function を `await` で呼ぶ」1 形式に collapse、書き心地統一。Path 1 (= 型貫通で痛み吸収) を最終形まで具体化。

read 系 (`getPost`) は server component 内で **server で実行**、stub 化なし。書き系 (`createPost`) は island から呼ぶ時に **stub 化 (POST 経由)**。**同じ関数が context に応じて挙動が変わる** = memory `project_vidro_rsc_like_core_model` の「両側実行 default」と一致。

### 3 層 mapping の機構誘導 (= memory `project_layer_separation_principle` の更新)

memory `project_layer_separation_principle` (49th softening) の元の表現 = 「component は pure rendering only」を更新:

> component (= page / island) は **handler 層**。component の中で service (= server.ts named export) を await して business logic を起動する。component は **rendering + handler 制御**を持つが、**business logic / db 直叩きはしない**。

これにより:

- Next.js App Router の async component メンタルモデル流用可能 (= 学習コスト低)
- ただし db 直叩きしない (= service 層経由で機構誘導)
- 「3 層分離」が公式推奨として自然に出る (= memory `project_layer_separation_principle` の 49th softening 整合)

### `defineAction` wrapper を採らない理由

memory `project_adr_0070_pending` の Sketch A は `defineAction({ input, handler })` 形だったが、本 ADR では却下。理由:

- input + handler の 2 引数構造は **middleware chain を表現しにくい** (= Hono `app.post(mw1, mw2, h)` 慣習から外れる)
- input schema は middleware の 1 種 (= validator middleware) として表現する方が直交、Hono `@hono/zod-validator` 直系
- middleware 引数として渡せると、auth + rate limit + validator + custom transform 等を chain できる (= 拡張性高)

本 ADR の `serverFn(validator(schema), authMw, rateLimit(), handler)` 形は、Hono の middleware chain そのまま。`defineAction` の特化 wrapper は不要。

## Consequences

### Pros

- **schema 重複ゼロ** (= ADR 0070 元々の入口を 8-A で解消、ファイル 1 個増えない)
- **北極星 (= read/write 統一 `await fn()`) 着地** (= 3-trigger Path 1 完成)
- **Server Actions 4 脆弱性を構造的に削る** (= Flight 不採用 / hash ID 不採用 / URL 透過 / closure 拒否)
- **3 層責務分離が機構誘導** (= memory `project_layer_separation_principle` 整合)
- **routes/ 配置時の middleware 自動継承 bonus** + **function 単位 wrapper の self-managed default** (= Hono 流の透明性 + Rails 流の安全 default を構造で同居、Server Actions / TanStack が片寄せた middleware 機構の Vidro 独自路線)
- **mode 排他で URL 衝突問題ゼロ** (= Z-1 採用が成立、prefix なし)
- **場所縛り強制ゼロ** (= server function を routes/ 内 / features/ / api/ どこでも書ける、scale-aware に user 判断、memory `project_fw_design_stance` 整合)
- **物理判定原則** (= 拡張子で server/client を表明、bundler は AST 切り出し magic 不要、`*.client.tsx` / universal `.tsx` 内 inline は build error)
- **Hono / TanStack Start メンタルモデル流用可能**、学習コスト低
- **型貫通 #4 + #9 完成** (= form input → action 引数型 + submission.input ← action 引数逆引き、9 経路中 7/9)
- **co-location 維持** (= server.ts 1 ファイルで service 集 + schema、handler は同 directory の page component、規模 XS は `*.server.tsx` で 1 file 完結も OK)
- **`getRequestEnv<T>()` 統合**で AppRouter mode は ALS magic 軽減、`c.env` 引数注入で legibility 上昇

### Cons / 残るリスク

- **bundler 拡張要** (= server.ts の export 種別判定、stub generation、closure capture build error、route 単位 middleware 認識)
- **mode 排他なので 1 project 内で AppRouter / Pages 混在不可** (= ただし memory `project_design_north_star` 規模感と整合)
- **wrapper 学習要** (= `serverFn` / `validator` 概念、ただし TanStack Start / Hono 慣習)
- **closure capture build error は実装 phase の判断** (= lint warn vs build error の選択 Open Question、初期は warn 寄り)
- **Pages mode と AppRouter mode で `server.ts` の意味が違う** (= mode で切り替わる、ただし排他なので user 認知負荷低)
- **ADR 0068 部分 supersede** (= AppRouter mode の同 path action 概念は server function 集に再フレーム、Pages mode はそのまま継承)
- **memory `project_form_design_decided` 一部 invalidate** (= 共存可 → 排他、AppRouter mode の form 経路は island + server function で固定、3 経路 → 1 経路)

### 既存 ADR との関係

- **ADR 0049 (loaderData primitive)**: Pages mode で継承、AppRouter mode では server component が `await getXxx()` で代替
- **ADR 0051 (derive optimistic with intent)**: Pages mode で継承、AppRouter mode で superseded (= intent pattern は HTML wire form 専用、関数名 discriminate に置換)
- **ADR 0058 (`.server.tsx` semantics)**: 影響なし、AppRouter mode の handler は async server component
- **ADR 0064 (resource 1pass unification)**: 影響なし、`resource()` は render mount trigger として継続
- **ADR 0065 (scope context cross async)**: 内部実装で活用、`c.var` / `c.get` の cross-async 値受け渡しに利用可能
- **ADR 0066 (async server component native)**: 強化、handler 層が `await getPost()` で service を呼ぶ流儀。`getRequestEnv<T>()` は `c.env` に統合
- **ADR 0067 (per-route +types codegen)**: 拡張、server function の typed import (`Route.ServerFns` 等) を将来追加候補
- **ADR 0068 (action 置き場 + resource route)**: 部分継承 + 部分 supersede。Pages mode では ADR 0068 そのまま、AppRouter mode では `index.server.tsx` の `action` export と `server.ts` 単独 directory が **server function 集の認識**に再フレーム
- **ADR 0069 (`formControl` primitive)**: 整合、`formControl({ schema })` は server function と同 schema 共有 (= 重複ゼロ)、AppRouter mode の island form の主軸として連動
- **ADR 0071 (`@vidro/zod` opt-in pack)**: 連動起票、`validator(schema)` middleware の詳細

### 既存 memory との関係

- `project_adr_0070_pending`: 着地、status 「✓ ADR 0070 で着地」に update、3 sketch を構造的整理で解消
- `project_form_design_decided`: 共存可 → 排他に update、AppRouter mode の form 経路は island + server function で固定 (= 3 経路 → 1 経路に絞る)
- `project_layer_separation_principle`: component pure rendering → component が handler 層に update、3 層 mapping 確立、routes/ 外配置 (= features/ / api/) も合法とする scale-aware 整合追記
- `project_frontend_fw_3trigger_asymmetry`: Path 1 完成、3 trigger を `await fn()` 1 形式に collapse
- `project_action_phase3`: ADR 0051 + intent pattern は Pages mode で継承、AppRouter mode で superseded (= 関数名 discriminate)
- `project_html_first_wire`: AppRouter mode の wire は JSON、HTML-first 例外条項 (= action result) に該当 (= 再確認)、URL 透過哲学を server function URL 命名に展開
- `project_vidro_zod_pack_pending`: ADR 0071 で起票、本 ADR と連動着地、memory finalize
- `project_design_north_star`: 整合、RSC simpler 代替の核心ピース (= 3-trigger Path 1 + 4 脆弱性削除)
- `project_legibility_test`: 「想定したものと等価なら magic 許容」原則を本 ADR で言語化、加えて「物理判定 (= 拡張子で実行場所を表明) > AST 切り出し magic」を `*.client.tsx` / universal `.tsx` 内 inline `serverFn` 却下の判断軸として明文化、memory に追記候補
- `project_app_scaffolding_strategy`: mode 排他なので create-vidro CLI で mode 選択 UX が今後必要 (= 起票 trigger)
- `project_adr_0066_status`: `getRequestEnv<T>()` を `c.env` に統合、ALS dependency 軽減
- `project_form_dogfood_2026_05_08`: 痛み点 3 (= 型貫通 #4) は ADR 0069 + 0070 + 0071 連動で完全解決
- `project_fw_design_stance`: middleware 文脈で「self-managed default + routes/ 配置 bonus」というハイブリッド stance を具体化、強制せず機構誘導の middleware 実装案として確定

## Affected files (実装着地時)

- `packages/plugin/src/`: bundler 拡張
  - **`server.ts` / `*.server.tsx` の named export** を server function として識別 (= 場所縛りなし、ファイル名で識別)
  - **universal `.tsx` / `.client.tsx` 内 inline `serverFn(...)` を build error** (= 物理判定原則、AST 切り出し magic を避ける)
  - client bundle で `import { fn } from "./server"` (or `from "./xxx.server"`) を fetch stub に置換
  - URL 生成 = src 相対 path (= routes/ 内のみ strip)
  - `middleware.ts` 認識 + **routes/ 内のみ** path 階層 middleware chain 構築 (= routes/ 外は継承なし)
  - closure capture 検出 (= build error or lint warn、初期は warn)
  - mode 排他判定 (= `vidro.config.ts` の `mode` field 読み)
- `packages/router/src/`: routing 拡張
  - server function URL pattern (= `[slug]` dyn segment + 関数名 suffix) の認識、routes/ 内/外両対応
  - routes/ 内: directory `middleware.ts` の path 階層自動継承 chain 適用
  - context (`c`) 構築 + Hono c subset API 提供 (= `c.req.url`, `c.req.headers`, `c.req.query`, `c.get`, `c.set`, `c.var`, `c.env`, `c.executionCtx`)
- `packages/core/` or `packages/router/`: `serverFn()` factory 実装
  - middleware chain (= rest 引数で複数 middleware + 最後に handler)
  - context 注入
  - position 引数 → URL/body 振り分け
- `packages/router/src/serverFn.ts` (新規候補): factory + types
- `vidro.config.ts` schema: `mode: "pages" | "app"` field 追加
- `packages/zod/` 新規 (= ADR 0071): `validator(schema)` middleware
- `apps/blog/`: dogfood Phase 7 で AppRouter mode 移行 (= 段階的、本 ADR Accepted 化後)

## Validation (= Accepted 化までに実施)

- 既存 ADR (0001-0069) との矛盾 check (= 上記表で実施済、ADR 0051 / 0068 は部分 supersede として明示)
- 既存 memory との整合 check (= 上記 cross-check 表で実施済、memory update 範囲を `project_layer_separation_principle` / `project_form_design_decided` / `project_frontend_fw_3trigger_asymmetry` / `project_action_phase3` / `project_legibility_test` / `project_adr_0070_pending` で finalize)
- user 合意取得 (= 8 論点 = export 形 / mode / wire / URL / middleware / context / dynamic param / schema、58th session で confirm)
- `feature-dev:code-reviewer` agent review (= memory `feedback_review_in_workflow` per、Accepted 化前 or 実装 commit 直前)

## Next steps (= Accepted 化後)

### 段階的 commit 推奨順序

1. **Phase 1**: `serverFn()` factory + context (`c`) subset 実装 (= `packages/router/` or `packages/core/`)
2. **Phase 2**: bundler 拡張 (= `server.ts` 内 export 識別、fetch stub generation、URL = Z-1)
3. **Phase 3**: route 単位 middleware (= directory `middleware.ts`) 認識 + chain 適用
4. **Phase 4**: closure capture build error 検出 (= 初期 lint warn、痛み顕在化したら build error 昇格)
5. **Phase 5**: `vidro.config.ts` `mode` field + bundler 分岐 (= Pages mode / AppRouter mode)
6. **Phase 6**: ADR 0071 (`@vidro/zod`) と連動、`validator(schema)` middleware 提供
7. **Phase 7**: dogfood blog migration (= `apps/blog` の AppRouter mode 化、`server.ts` を server function 集に書き換え、formControl + island で form を実証)

各 Phase は独立コミット可能 (= memory `feedback_collaboration_style` 流の小さな commit)。

## Open Questions

1. **closure capture 検出を build error にするか lint warn にするか** — 初期は warn、痛み出たら build error 昇格。memory `project_legibility_test` 「想定外を防ぐ」基準では build error 寄り
2. **`c.redirect()` 相当の必要性** — server function は値返すモデル、redirect は別 throw 機構 (= `redirect()` primitive throw) で代替する案。Pages mode の `Response.redirect` との関係再評価が必要
3. **Pages mode と AppRouter mode を同 project で混在検出をどう警告するか** — `vidro.config.ts` mode を見て build error にするか、warn 止まりか (= memory `project_fw_design_stance` 「強制せず機構誘導」整合判断)
4. **AppRouter mode で `<form method="post">` を island から submit する場合の data 経路** — formControl が JSON にする想定で OK か、FormData wire を別途許容するか
5. **server function の戻り値が `undefined` / `void` の時の wire** — 204 No Content か、空 JSON か、null か
6. **server function 内で error を throw した時の wire** — JSON `{ message, status }` 形式か、純粋 5xx か、ADR 0063 (SSR throw shape) との整合
7. **`server.ts` の naming** — AppRouter mode では service 集として意味が変わるが、命名は当面据え置き (= 後で動かせる、user 判断 2026-05-09 末)
8. **read 系 service (= `getPost` 等) を island から呼ぶケース** — 本 ADR は write 系を主に整理したが、read 系も同形で stub 化される (= 同じ機構で動く、別途検証)
9. **global middleware (= 全 server function 共通)** — TanStack Start の `start.ts functionMiddleware` 相当。CSRF token 検証 / リクエストロギング等の cross-cutting で需要可能。**初期 YAGNI**、痛み顕在化したら別 ADR で起票
10. **routes/ 外配置時 middleware 書き忘れの lint warn** — `serverFn(handler)` (= middleware なし) の routes/ 外配置に warn 出すか、完全自由とするか

## Revisit when

- **bundler stub generation の inspect UX が不足** → `vp build --inspect-stub` 等の実装着手時
- **closure capture lint warn が漏れる事故が起きる** → build error への昇格 trigger
- **Pages mode を完全廃止する判断** → AppRouter mode dogfood で 100% カバー確認後
- **mode 切り替え helper (= migrate-to-app-mode) が必要** → 実利用者から痛み顕在
- **Hono c API が大きく変わる** → c subset 互換性再評価
- **server function の戻り値 wire 形が痛み顕在** → Open Question 5 / 6 を別 ADR で起票
- **type 貫通 #5+#6 (= Link/navigate typed routes) の path 認識** → 本 ADR の Z-1 URL 命名と統合判断、別 ADR 起票
- **read 系の island 呼び出しで痛み顕在** → server component 内 read と island 内 read の使い分け再整理
