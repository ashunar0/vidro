# Vidro システム構造の整理 — 3 軸 × 3 層 × 3 boundary

> このノートは、フルスタック fw の議論で muzumuzu したときに位置を確認する
> ためのフレーム。新しい primitive を設計するときの整合性チェックにも使う。
> ADR ではなく、自分で見返すための学習用メモ。

## なぜ整理が要るのか

フルスタック fw (Vidro / Next.js / Solid Start / Remix) は便利な反面、
「サーバー / クライアント / fw / レイヤー / wire」 が頭の中でごちゃ混ぜ
になりがち。これは **同じシステムを複数の異なる軸で同時に切ってる** ことが
原因で、軸を意識して切り分ければ muzumuzu は解消する。

このノートでは 3 つのフレームを定義する:

1. **3 軸**: どう切るか (物理 / 内部論理 / fw ロール)
2. **3 層**: 責務をどう分けるか (backend / server-side FE / client-side FE)
3. **3 boundary**: server↔client をどう分けるか (wire / 物理 / 論理)

---

## 1. 3 軸 — 同じシステムを 3 通りに切る

### 切り方 1: 物理 (どこでコードが走るか)

```
[Client Browser]  ←─ 通信線 ─→  [Server (Cloudflare Worker)]  ──→  [DB]
```

- **Browser**: user の手元で走る JS。インタラクティブ性、reactive 更新
- **Network**: HTTP request/response。HTML / JSON / form data が流れる
- **Server**: 要請を受けて応答する場所
- **DB**: 永続化、外部 API 等

### 切り方 2: 内部論理 (server コードの責務分離 = Clean Architecture)

```
[HTTP request]
     ↓
┌─────────────────────────────────────┐
│  routes layer (server.ts)           │  ← URL を受ける、loader/action
│  ↓                                   │
│  application layer (use case)       │  ← business 操作 (例: createPost)
│  ↓                                   │
│  domain layer (entities/types)      │  ← Post 型、ビジネスルール
│  ↑                                   │
│  infrastructure layer (DB/API)      │  ← postRepo.findAll() 等
└─────────────────────────────────────┘
     ↓
[Response]
```

依存方向: `routes → application → domain ← infrastructure`
これは server 内部の論理的な責務分離。物理的には全部同じ machine で走る。

### 切り方 3: fw ロール (どの fw / primitive が何の責務か)

例えば Hono + Inertia + React の構成では:

```
[ Hono ]  ──  [ Inertia ]  ──  [ React ]
 server         wire             client
 routing       protocol         rendering
 + biz logic   + props bridge   + UI
```

Vidro は 1 fw でこれら全部を担当するが、**ロールとしては内側で同じ分業がある**。

### 3 軸は直交、同時に true

これら 3 軸は互いに **直交**で、**同時に true**。muzumuzu の正体は
「複数の軸を同時に見てて頭の中で混ざる」こと。
議論する時は 「これはどの軸の話か」 を明示するルールを取る。

---

## 2. 3 層 architecture — 実用的な責務分け

3 軸を統合した実用的なレイヤー分けがこれ:

```
[Backend]                          ← business logic
  ├ application (use case)
  ├ domain (entities)
  └ infrastructure (DB / 外部 API)
  └ "HTTP も URL も知らない、純粋"
       │
       │ ←─ TS 関数呼び出し (= 自然な type-safe seam)
       │
[Server-side Frontend]             ← URL を知ってる
  ├ routes / loader / action
  ├ SSR / HTML 生成
  └ bootstrap data 注入
       │
       │ ←─ wire (HTML + JSON sidecar) ← 型貫通の対象
       │
[Client-side Frontend]             ← DOM を知ってる
  ├ hydrate
  ├ signals / effects / events
  └ navigation / interactivity
```

各層の責務:

- **Backend**: HTTP も URL も知らない、純粋。**Vidro core/router は touch しない**
  (= 完全に user 領域、Clean Architecture 自由)
- **Server-side FE**: URL を知ってる、page 単位、backend を関数で呼ぶ
- **Client-side FE**: DOM を知ってる、user interaction を扱う

この 3 層分割が「Hono + Inertia + React が綺麗に見えた」ときの構造。
Vidro は 1 fw だが、論理的にこの 3 層を維持する。

---

## 3. 3 boundary — server↔client を分ける手段

「サーバーとクライアントの境目をはっきりさせる方法」 と聞かれたとき、
答え方が 3 通りある。

| 種類        | 何で boundary を作るか         | 例                               | pros                        | cons                   |
| ----------- | ------------------------------ | -------------------------------- | --------------------------- | ---------------------- |
| **A. wire** | HTTP の wire format            | Inertia, tRPC, HTMX              | 設計対象が小さい、観察可能  | 粒度が粗い (page 単位) |
| **B. 物理** | ファイル拡張子 / フォルダ      | Astro Islands, RSC               | 細粒度、bundle 最適化と直結 | ファイル数が増える     |
| **C. 論理** | runtime mode (`isServer` 判定) | universal SSR, Next "use client" | コード共有最大              | **一番 muzumuzu する** |

### Vidro の position: A + B ハイブリッド、C 最小化

- **A (wire) が主**: loader return / bootstrap JSON / island props が wire を越える、
  型貫通で型を保証
- **B (物理) が補助**: `.server.tsx` / `.client.tsx` で「bundle に乗る/乗らない」を
  file extension で明示
- **C (論理) は避ける**: 「同じファイルの中で server と client が混在」を許さない
  (= Next.js の `"use client"` を却下したのはこの理由)
- **Backend は完全に user 領域**: Vidro core/router は routes layer 以外触らない

---

## 用語チートシート — どの軸の話か

ごちゃつきがちな用語を、上の 3 軸のどこに属するかで整理:

| 用語               | 軸                                |
| ------------------ | --------------------------------- |
| SSR                | 物理 + wire (A)                   |
| hydrate            | 物理 (client)                     |
| RSC                | wire (A) + 物理 (B)               |
| Server Component   | 物理 (server-only)                |
| Client Component   | 物理 (client)                     |
| Server Action      | 物理 (server) + wire              |
| loader             | 物理 (server) + 内部論理 (routes) |
| use case / service | 内部論理 (application)            |
| repository         | 内部論理 (infrastructure)         |
| signal             | 物理 (client)                     |
| Islands            | wire + 物理 (B)                   |
| Inertia            | fw ロール + wire (A)              |
| 型貫通             | 3 軸全てに横串                    |
| 層分離原則         | 内部論理 (Clean Arch)             |

---

## Vidro が「綺麗な層」を保つための 4 ルール

1. **Backend を fw から切り離す**
   - Vidro core/router は routes layer 以外には触らない
   - `application/`, `domain/`, `infrastructure/` は user code
2. **wire を意識的に「設計対象」として小さく保つ**
   - 型は通すが REST API のような大規模設計はしない
3. **物理 boundary (拡張子) を type で連結**
   - `.server.tsx` ↔ `.client.tsx` 型貫通
4. **universal mode (C) は最小化**
   - `"use client"` 系の罠を避ける

---

## 議論で使うときの作法

- 議論で muzumuzu したら 「これはどの軸の話か」 を最初に確認
- 新 primitive 提案時に 3 軸 × 3 層 × 3 boundary に当てはめて整合性チェック
- ADR で 「本 ADR はどの軸の決定か」 を冒頭で明示
- 用語が混ざったら上のチートシートに戻る

## 関連

- `docs/notes/02-html-first-wire.md` — wire format の選択 (A boundary の具体)
- `docs/decisions/` — ADR (個別の設計判断、本ノートを基盤として参照)
- 設計書 `~/brain/docs/エデン 設計書.md` — 5 哲学
