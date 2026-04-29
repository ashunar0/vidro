# Hono + Inertia 参照ノート — Vidro 設計の参照点

> このノートは Hono + Inertia の組み合わせを Vidro 設計の参照点として残したもの。
> 設計判断で迷った時に「Hono + Inertia ならどう書くか?」を比較対象として持ち、
> Vidro の API / 哲学を磨く軸にする。brain の「Hono × Inertia 言語化メモ」
> (2026-04-28) を Vidro 観点で再構成 + 拡張。

## なぜ Vidro が Hono + Inertia を参照するか

Hono + Inertia は Vidro が目指す方向の **既存実装に最も近い参照点**:

- **Cloudflare Workers primary** な runtime (= Vidro と同じ)
- **HTML-first wire** + **JSON 例外** (= Vidro の設計原則と同じ、ただし wire 細部は違う)
- **API レイヤー削減** (= Vidro の "loader props 直渡し" と同方向)
- **server-driven state, client passive** (= Vidro の "fine-grained reactivity + signal"
  とは方向性違うが、参考になる)
- **TS 型貫通** (= Vidro identity の核、Inertia は page 単位で型貫通成立済)
- **設計対象を小さく保つ** (= "wire format の 4 フィールド固定" は Vidro が学ぶべき哲学)

設計書 5 哲学のうち「型貫通」「Hono的透明性」「Clean Architecture 層分離」 の 3 つは
直接的に Hono + Inertia の延長線上にある。

## Hono + Inertia の本質: 4 つ消える

Hono × React + React Router の構成と比較して、Inertia 導入で **4 つの責務が消える**:

| 消えるもの                              | なぜ要らない                                                                 |
| --------------------------------------- | ---------------------------------------------------------------------------- |
| **API エンドポイント** (`/api/posts`)   | 同じルート `/posts` が `X-Inertia` ヘッダで HTML/JSON を切り替えるから       |
| **クライアントルーター** (React Router) | サーバが「次このコンポーネント表示せよ」と命令するので、二重持ちしなくていい |
| **fetch + useEffect**                   | props でデータが直接降ってくるので、自分で fetch する必要がない              |
| **useState** (取得 data 用)             | サーバが state の単一の真実、クライアントは props を表示するだけ             |

state の場所が **「サーバとクライアントの両方」→「サーバだけ」** に一元化される。

## 中心思想: Inertia は 2 箇所に住んでる

```
[サーバ側] @hono/inertia middleware
  → リクエスト見て「HTML でくるむ or JSON だけ返す」を分岐

[クライアント側] @inertiajs/react (<Link> / createInertiaApp)
  → <Link> クリック時に X-Inertia ヘッダ付きで fetch、レスポンス受けて差し替え
```

両者が **`X-Inertia` ヘッダ** を合言葉に通信する。

## 動作の流れ

### 初回 (リロード or 直アクセス)

```
Browser → Hono /posts (X-Inertia なし)
        ← HTML + 埋め込み JSON {component: 'Posts/Index', props: {...}}
Browser: HTML 描画 → client.tsx 起動 → JSON 読む → <Posts/Index> mount
```

### 2 回目以降 (`<Link>` クリック)

```
Inertia client → Hono /posts (X-Inertia: true ヘッダ付き)
              ← JSON だけ {component: 'Posts/Index', props: {...}}
Inertia client: 動的 import で Posts/Index.tsx ロード → 既存 DOM に差し替え
```

サーバ側コードは `c.render('Posts/Index', { posts })` の **1 行だけで両方カバー**。

## c.X() で見る Hono の世界観

```ts
c.json({ posts })                    // → application/json
c.html(<Posts posts={posts} />)      // → text/html (hono/jsx)
c.render('Posts/Index', { posts })   // → Inertia: 初回 HTML / 2 回目以降 JSON
```

**ルーティングや middleware は同じ、返し方だけが違う**。`c.render()` の中で middleware が
「初回か SPA 遷移か」を判定して中身を切り替える。

## propsの型貫通 (= 美しさの基底)

```tsx
// src/server.tsx
.get('/posts/:id', (c) => c.render('Posts/Show', { post: findPost(id) }))
//                        ^^^^^^^^^^^^^^               ^^^^^^^^^^^^^^^^^
//                        型 check 対象                 この型がそのまま貫通

// app/pages/Posts/Show.tsx
export default function Show({ post }: PageProps<'Posts/Show'>) {
  // post.title が型補完される ← サーバから流れてきている
}
```

**仕掛け**: `@hono/inertia/vite` plugin が `pages.gen.ts` を自動生成し、`AppRegistry` に
`typeof app` を登録。`PageProps<'Posts/Show'>` はこの `AppRegistry` 経由で
`c.render('Posts/Show', X)` の `X` の型を逆引きする。

→ **fetch の戻り値を `as Post` でキャストする悲しみがない**。

## バリデーションと zod schema

### Single Source of Truth = zod schema

```ts
// posts.ts に 1 個の schema
export const postInputSchema = z.object({
  title: z.string().min(1, 'タイトルは必須です').max(80, '...'),
  body: z.string().min(1, '本文は必須です').max(2000, '...'),
})

// 派生する 3 つのもの:
export type PostInput = z.infer<typeof postInputSchema>  // ← 型
zValidator('json', postInputSchema, ...)                  // ← サーバ実行時バリデーション
errors: { title: 'タイトルは必須です' }                    // ← クライアントに届くメッセージ
```

**1 個の schema から、型・バリデーション・エラーメッセージが派生する**。書き換えるのは
schema 1 箇所だけ。

### エラーは「ステータスコード」じゃなく「props の一種」

```
普通の SPA:
POST → 422 Unprocessable Entity → JSON {errors} → クライアントが state 更新 → エラー表示

Inertia 式:
POST → 200 OK + 同じフォームページを {values, errors} 付きで再描画 → 自然にエラーが表示
```

**ステータスコードを使わず、ページ再描画だけでエラー表示が成立する**。Rails 時代の
サーバ駆動世界観の継承。

### 入力値の保持も props で

```tsx
return c.render('Posts/New', {
  values: { title: 入力値, body: 入力値 },  // ← フォームの中身が消えない
  errors: { ... },
})
```

サーバが「ユーザーが入力した値」を props で送り返す → `useForm` がその値で初期化 →
**state 保持のための localStorage / sessionStorage 不要**。

## 歴史的位置づけ

```
Rails / Laravel  : サーバが全権持つ、HTML をサーバ描画、クライアントはダム
       ↓
普通の SPA       : クライアントが独立、サーバは API だけ、両者で型同期問題
       ↓
Inertia         : サーバが全権持つ、ただし View は React、クライアントは指示待ち
```

Inertia 界隈で **"the modern monolith"** と呼ばれる。React/Vue の書き心地のまま、Rails
時代のシンプルさに戻る。

## Vidro の継承点 / 拡張点

| 観点               | Hono + Inertia                          | Vidro                                                    |
| ------------------ | --------------------------------------- | -------------------------------------------------------- |
| **wire 形式**      | 初回 HTML + 2 回目以降 JSON             | 全経路 HTML + 3 つの JSON 例外 (= ノート 02)             |
| **API 削減**       | endpoint なし                           | 同じく endpoint なし (loader props 直、action server.ts) |
| **client router**  | Inertia client が動的 import で差し替え | `@vidro/router` が同等                                   |
| **state 単一真実** | サーバ側                                | サーバ側 (loader) + 必要時に client signal               |
| **型貫通**         | page 単位 (flat)                        | **page + Islands tree composition** (= 拡張)             |
| **reactivity**     | React (coarse)                          | **fine-grained signal** (= 拡張)                         |
| **エラー**         | props として再描画                      | 同じく props or submission.error                         |
| **対象規模**       | 個人 〜 中規模                          | 個人 〜 中規模 (memory `project_design_north_star`)      |

### Vidro が Hono + Inertia から **直接借りる**もの

- **API エンドポイント不要** の発想 (= loader props 直渡し)
- **TS 型貫通** の仕組み (= `c.render` の引数型 → component props 型)
- **エラー = props の一種** の哲学 (= ステータスコード分岐回避)
- **"設計対象を小さく保つ"** 哲学 (= wire format を 4 フィールドに固定する潔さ)

### Vidro が **超える**領域

- **Islands tree composition**: Inertia は page 単位 (1 page = 1 props で flat)、
  Vidro は `.server.tsx` ↔ `.client.tsx` 越しの型貫通でネスト構造に対応する想定
- **fine-grained reactivity**: Inertia の React は coarse re-render、Vidro は signal
  ベースで「変わった節点だけ更新」(= memory `project_html_first_wire`)
- **HTML default 経路の徹底**: Inertia は 2 回目以降は JSON only、Vidro は HTML を default
  に保つことで progressive enhancement と整合する

### Vidro が **意識的に取らない**もの

- **`X-Inertia` ヘッダで HTML/JSON 二重人格**: Vidro は経路ごとに wire を分ける
  (= 設計対象を小さく保つ別表現、ただし方向性は近い)
- **server-driven exclusive**: Vidro は client signal も第一級、Hybrid

## 設計判断時の checklist (Vidro 用)

新 primitive / API を提案する時に問う:

1. **「Hono + Inertia ならどう書くか?」を target syntax として書いてみる** (= memory
   `feedback_dx_first_design`)
2. その target syntax の **何が美しいのか** を言語化 (props 直渡し / 型貫通 / wire 薄さ)
3. Vidro 流に翻訳した時に **同じ美しさを保てるか**
4. 保てないなら、それは **Vidro の独自性 (= fine-grained / Islands tree) のため許容**
   できる trade-off か
5. 4 が No なら **Hono + Inertia の解を直接借りる** (= 独自路線にしない)

## 関連

- `docs/notes/01-system-architecture.md` — boundary 3 種類 (A: wire / B: 物理 / C: 論理)、
  Vidro は A + B、Hono + Inertia は A 主軸
- `docs/notes/02-html-first-wire.md` — wire format 設計原則、Inertia と Vidro の wire
  形式の差を整理
- `docs/notes/03-cache-as-fw-concern.md` — 薄い core + 厚い optional pack 構造
- memory `project_type_vertical_propagation.md` — 型貫通 ADR (Inertia の page 単位を
  Islands に拡張)
- memory `project_design_north_star.md` — Vidro 北極星 (RSC simpler 代替)
- memory `feedback_dx_first_design.md` — user コードの見た目を起点に逆引き
- brain `Hono × Inertia 言語化メモ` — 原典 (= 個人ノート版、こちらは Vidro 設計参照向け)
