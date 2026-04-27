# ADR 0042 — nested action: `layout.server.ts` の `action` サポート (path 完全一致)

- Status: Accepted
- Date: 2026-04-27
- 関連 ADR: 0037 (R-min action), 0038 (R-mid-1 per-key submission), 0041 (navigation flush)

## 背景 / 動機

ADR 0037 / 0038 / 0040 / 0041 で submission 周りはほぼ完成したが、**action は leaf
(`server.ts`) のみで export 可能** という制約が残っていた。`layout.server.ts` には
`loader` を export できるが、`action` は export しても server 側の `handleAction`
が leaf の `match.server.load` しか見ないため、無視される。

これだと「**leaf に index.tsx が無い path** に effect する action」が作れない:

- `/admin/users/123` のような nested route で、`/admin` 全体に効く管理 action
- `/users` に index.tsx + server.ts が **無く** layout.tsx + layout.server.ts のみ
  ある場合、`/users` への POST が 405 になる

R-mid-3 はこの隙間を埋め、**layout 自体が action を持てる** ようにする最小拡張。

## 設計判断

### 1. `layout.server.ts` の `action` export を許可する

型は既存の `ServerModule = { loader?, action? }` をそのまま使える。`route-tree.ts`
の `LayoutEntry.serverLoad: ServerModuleLoader | null` も既に `ServerModule` を
返せる shape なので、**route-tree 側の改修はゼロ**。`compileRoutes` の挙動は不変。

### 2. action 解決順序: leaf 優先 → 同 path layout fallback

`handleAction` で POST URL.pathname に対する match を取り、

1. `match.server` (= leaf の `server.ts`) を load → `action` があればそれを呼ぶ
2. 1 が無ければ、`match.layouts` の中から **pathPrefix が url.pathname と完全一致**
   する layout を探し、その `serverLoad` を load → `action` があればそれを呼ぶ
3. それも無ければ 405 `NoActionError`

「leaf 優先」: 同 path に leaf + layout の両方 action がある場合は leaf を取る。
理由: form の `action="/users"` が「`/users` path の owner」を指す感覚と整合し、
Remix の挙動 (route segment ごとに独立、leaf が page を担当) とも揃う。

**「完全一致」は動的 segment 対応必須**: `pathPrefix = "/users/:id"` (動的) は実 URL
`/users/123` にマッチさせる。`LayoutEntry.pattern` は **prefix-match** 用 (= 子 path
も拾う) なのでそのままは使えない。`server.ts` 内に `:name` を `[^/]+` 化する完全一致
RegExp helper (`layoutPathMatchesExact`) を持たせて判定する。

**1 dir = 1 layout**: ファイルシステム上、同じ dir に `layout.tsx` は 1 つしか置けない
ため、`pathPrefix === url.pathname` を満たす layout は **構造上高々 1 件**。複数候補
の優先順位は議論不要。

### 3. **path 完全一致のみ**、deepest-first fallback はやらない

`/admin/users` の POST は `/admin/users` の leaf or 同 path layout のみ。
`/admin` の layout action にはフォールバック **しない**。

理由:

- 完全一致のみが「path = action の identity」というメンタルモデルとシンプル
- deepest-first fallback は「どの layer が呼ばれるか」が path 解析の暗黙ルールに
  依存し、user が予測しにくい
- Remix も path 完全一致のみ

### 4. layer 同時呼出 / 専用 dispatcher は **不要**

memo 草案では「nested では layer ごとの dispatcher が要る可能性」と記載していたが、
**path-based dispatch 1 個で十分**。submission の `submit({ action: "/users" })` で
path を指定すれば、Router の唯一の dispatcher が path → fetch → handleAction の
経路で適切な layer の action に届く。dispatcher 階層化は YAGNI。

### 5. loader 自動 revalidate は既存挙動のまま

`gatherRouteData(pathname)` は match の全 layer (= layouts + leaf server) の loader
を並列実行する設計なので、layout action 後の revalidate も全 layer 揃って revalidate
される。**改修不要**。

## 実装ファイル

新規:

- `docs/decisions/0042-nested-action-layout-server.md` (本 ADR)

修正:

- `packages/router/src/server.ts`
  - `handleAction` を「leaf action → 同 path layout action fallback → 405」の 3
    段に拡張
  - 405 メッセージは「leaf に action なし & 同 path に action 持ち layout もなし」を示す
- `apps/router-demo/src/routes/users/layout.server.ts`
  - 既存 loader に加えて `action` を export (`/users` 全体に効く軽量 action)
- `apps/router-demo/src/routes/users/index.tsx`
  - `<form method="post" action="/users" {...sub.bind()}>` で layout action を呼ぶ demo
- `packages/router/tests/server-action.test.ts`
  - layout action ケース 3 件追加 (leaf 優先 / leaf 無し時 layout fallback / 両方無し 405)

## 残課題 (本 ADR では touch しない)

- **deepest-first fallback** (`/admin/users` POST が `/admin` layout の action に落ちる)
  - 別 ADR で「auth middleware 風 nested action」と一緒に検討 (Phase 5/6)
- **layer 同時呼出** (1 form で leaf + layout の両 action を呼ぶ)
  - Remix も非対応、Vidro でも YAGNI
- **action だけ持つ layout の loader 不在ケース**
  - 現状 `layout.server.ts` に loader 不在で action だけだと、`gatherRouteData`
    内で layer の data が undefined になるだけ (= 既存挙動を維持)
- **path-only addressing の限界**: 「同 path に複数 action」は表現できない
  - intent 分岐 (R-mid-2 demo) で対応する慣習で十分
