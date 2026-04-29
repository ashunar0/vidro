# HTML-first wire — Vidro の wire format design

> このノートは「サーバーとクライアントの間に何を流すか」 (= wire format)
> についての設計判断と、その背景を整理したもの。`docs/notes/01-system-architecture.md`
> の boundary type A (wire) を具体化する内容。

## 問題設定

フルスタック fw において、サーバーとクライアントの間を流れるデータ形式
(wire format) は設計の根幹。代表的な選択肢:

- **HTML over the wire**: server が HTML を返す、client は受け取って表示
  (HTMX, Phoenix LiveView, Hotwire/Turbo, Astro)
- **JSON / RPC**: server が data を返す、client が render する
  (Inertia, tRPC, SPA + REST)
- **Component tree (proprietary)**: server が component tree の serialized 表現を返す
  (React RSC の Flight format)

Vidro はどれを選ぶべきか？

---

## 各 fw の wire 実態

### Next.js App Router

| 状況                   | wire 形式                                             |
| ---------------------- | ----------------------------------------------------- |
| 初回 page load         | HTML (中に Flight payload を `<script>` 形式で embed) |
| client-side navigation | **Flight format (JSON)** だけ                         |
| Server Action          | JSON (Flight + redirect 指示)                         |
| revalidation           | Flight (JSON)                                         |

つまり Next.js は **初回だけ HTML、それ以降はほぼ全部 Flight**。
Flight は React proprietary な JSON 木構造 (`["$L1", {...}, "Hello"]` 等) で
人間可読性は低い。

### Inertia (+ Hono / Laravel / Rails)

| 状況                   | wire 形式                                                       |
| ---------------------- | --------------------------------------------------------------- |
| 初回 page load         | HTML (props を data attribute に embed)                         |
| client-side navigation | **JSON** (`{ component: "PageName", props: {...}, url: "/x" }`) |
| form submit            | JSON (新 props or redirect)                                     |

Inertia は navigation 後ずっと JSON wire。**HTML-first ではない**。

ただし wire format が「component name + props + url + version」の 4 フィールド
固定で、設計対象として極めて小さいのが特徴。

### HTMX / Phoenix LiveView / Hotwire

完全に **HTML 一本**。JSON は使わない。
これが「HTML over the wire」renaissance の代表格。

---

## なぜ React は JSON wire を要求するのか

React は **VDOM diff モデル** で動く:

1. component を再実行
2. 新 VDOM tree を生成
3. 旧 VDOM tree と diff
4. 差分を DOM に patch

これには 「現在の component tree を表す構造化データ」 が必要。
HTML は人間可読だが VDOM tree とは構造が違い、**再構築不可能な情報が落ちてる**
(text node の連結、event handler の attribute 化、key 情報の喪失等)。

なので React は wire に Flight format (= 構造化された JSON 木) を要請する。

## なぜ Solid / Vidro (fine-grained) は HTML で済むのか

fine-grained reactivity モデル:

- component は **invoke-once**、再実行しない
- 更新は signal が変化 → 該当 effect だけ再実行 → DOM の特定 node を書き換え
- **「tree を diff する」操作が無い**
- 「新しい tree を JSON で受け取る」 必要が無い
- HTML を受け取って、その HTML 内の island に signal を bind し直すだけで良い

**= fine-grained reactivity は HTML wire と構造的に相性が良い**。

---

## Vidro の design principle: HTML-first wire

Vidro の wire format design principle:

> **HTML を default wire format とする。JSON は限定的な 3 exception に絞る。**

### default = HTML

- 初回 page load
- client-side navigation (Link click)
- form submit (success / redirect)

これらは HTML (+ `__vidro_data` JSON sidecar) で wire を構成する。
sidecar は「型情報のための data 同伴」であって、画面構成は HTML が担う。

### exception = JSON

JSON を許す 3 場面:

1. **action result** (楽観的更新)
   - submit 中に画面に仮反映、後で server response で確定
   - 仮反映には client が data 構造を知ってる必要がある
   - 該当 action の result を JSON で返す
2. **明示的 client data fetch**
   - `createResource` 等で client から data を取りに行く
3. **細粒度 partial update**
   - 「list の 1 行だけ refresh」等、HTML fragment より JSON が筋が良いケース

それ以外で JSON を使いたい場合は **正当な理由を ADR に書く**。

---

## 型貫通との関係

「HTML wire だと型情報が落ちないか？」 という疑問への答え:

**wire format と型貫通の機構は独立している**。

### Inertia の型貫通の正体

```ts
// shared/types.ts
export type PostsProps = { posts: Post[] };

// server (Hono):
app.get('/posts', async (c) => {
  const posts = await listPosts();
  return c.inertia('Posts', { posts } satisfies PostsProps);
});

// client (React):
function Posts(props: PostsProps) { ... }
```

型は JSON wire を通って伝わってるんじゃなく、**TS の同一型を両側で参照してる**だけ。
wire は単に data を transport する役で、型情報は wire とは独立。

### Vidro の場合

HTML wire でも同じ機構で型貫通が成立する:

| 経路                                | wire                         | 型情報の運び方                           |
| ----------------------------------- | ---------------------------- | ---------------------------------------- |
| URL pattern → loader args           | (request)                    | route 定義の TS 型から build-time 推論   |
| loader return → component props     | HTML + JSON sidecar          | `LoaderData<typeof loader>` (共有 TS 型) |
| action signature → submission       | request body + JSON response | `submission<typeof action>` (共有 TS 型) |
| `.server.tsx` → `.client.tsx` props | HTML + island registry       | `import type` (共有 TS 型)               |

**型は wire format に依存せず、TS source code を通って伝う**。
HTML wire は型貫通の障害にならない。

---

## Vidro の現状 (Phase B 着地時点)

驚くべきことに、Vidro は既に「HTML-first + JSON sidecar」のハイブリッドを
Phase B で実装している:

```html
<!-- server response の構造 -->
<html>
  <body>
    <div id="root">
      <article>...rendered HTML...</article>
      <!-- メインの wire = HTML -->
    </div>
    <script type="application/json" id="__vidro_data">
      { "loader": {...}, "resources": {...} }     <!-- JSON sidecar -->
    </script>
  </body>
</html>
```

- HTML が「画面を作る道具」 (server で render 済み)
- JSON sidecar が「型情報を運ぶ道具」 (client が `LoaderData<typeof loader>` で型付きアクセス)
- 両方を 1 response に同居

このノートの design principle は、既存の挙動に **名前と意図を与える** もの。
新規実装ではなく既存方針の formalize。

---

## 競合 design との対比

| Approach             | wire                          | Vidro vs                                                |
| -------------------- | ----------------------------- | ------------------------------------------------------- |
| **React RSC**        | Flight (JSON tree)            | 却下: proprietary、VDOM 必須、transparency 哲学に反する |
| **Inertia**          | JSON (component name + props) | 部分採用: 型貫通の機構は近いが wire 主軸は HTML         |
| **HTMX**             | HTML 一本                     | 近い: HTML 主だが Vidro は JSON exception を許す        |
| **Astro Islands**    | HTML + 各 island に JS bundle | 近い: 同方向、Vidro は signal を fw が提供              |
| **Phoenix LiveView** | WebSocket HTML diff           | 却下: server stateful、Worker target と不整合           |
| **tRPC**             | JSON RPC                      | 却下: page 概念が無い、SPA 前提                         |

---

## 設計判断の checklist

新 primitive / endpoint を設計する時:

1. これは「画面を作る」用途か → **HTML**
2. これは client が data 構造を知る必要があるか → **JSON exception の 3 場面のどれか**
3. それ以外で JSON を使いたい → **正当な理由を ADR に書く**

## 関連

- `docs/notes/01-system-architecture.md` — boundary type A (wire) の位置付け
- `docs/decisions/0015-ssr-phase-a-bootstrap-data.md` — `__vidro_data` の起源
- `docs/decisions/0016-ssr-phase-b-universal-renderer.md` — server で HTML を組む経路
- `docs/decisions/0028-create-resource.md` — JSON exception 「明示 client fetch」の起源
- `docs/decisions/0037-action-primitive-remix-style-minimum.md` — JSON exception 「action result」の起源
