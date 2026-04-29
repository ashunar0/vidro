# ADR 0044 — `@vidro/router/client` の `boot()` helper で app bootstrap を 2 行に

- Status: Accepted
- Date: 2026-04-29
- 関連 ADR: 0027 (Vite glob 重複回避), 0036 (TTI shell boot trigger), 0043 (CF vite plugin 統合)

## 背景 / 動機

ADR 0036 (TTI 改善の boot registry idiom) を導入した結果、user の `src/main.tsx`
が **40 行強** に膨らんだ:

- vite の `import.meta.glob` で routes 一括 eager load (3 行) — vite 制約
- `hydrate` + `<Router />` 組立て (4 行) — Vidro の application bootstrap
- ADR 0036 の boot registry dance (`window.__vidroBoot` / `__vidroBootPending` /
  `DOMContentLoaded` fallback / idempotent guard、~15 行) — framework 内部 race
- `declare global` で `Window` 拡張 (5 行) — ADR 0036 globals の TS 補強

比較対象:

```tsx
// React (3 行)
import { createRoot } from "react-dom/client";
import App from "./App";
createRoot(document.getElementById("root")!).render(<App />);
```

```tsx
// Solid (3 行)
import { render } from "solid-js/web";
import App from "./App";
render(() => <App />, document.getElementById("root")!);
```

```tsx
// Vidro (40 行強) ← うざい
```

vidro-tutorial を実際に書いてる中で「`create-vidro` CLI を作った時、毎 app
これが出てくるのはダメ」というユーザー側の muzumuzu が顕在化。35 行は **Vidro
の application bootstrap が user concern なのか framework concern なのか**
の判断ミス (= 全部 framework concern が user 空間に漏れていた) と整理した。

## 設計判断

### 1. `@vidro/router/client` 新エントリで `boot(eagerModules)` を export する

router package の export 構成:

| entry                       | 用途                                                | 環境                 |
| --------------------------- | --------------------------------------------------- | -------------------- |
| `@vidro/router`             | `Router` / `Link` / `submission` 等 user 公開 API   | client / server 両方 |
| `@vidro/router/server`      | `createServerHandler` (`.vidro/server-entry.ts` 用) | server (workerd)     |
| `@vidro/router/client` (新) | `boot(eagerModules)` (`src/main.tsx` 用)            | client               |

`./client` は **app bootstrap 専用** で、Router 本体や Link は `@vidro/router`
から従来通り import する (= 用途別に entry を分けて bundle 内容を最小化する
ADR 0014 の方針を `client` にも拡張)。

### 2. `boot()` 内に framework 内部の race / convention を全て閉じ込める

helper が引き受ける responsibility:

- eagerModules → lazy `RouteRecord` 派生 (vite glob 重複 warning 回避、ADR 0027)
- `#app` 探索 + 不在時 throw
- ADR 0036 の boot registry idiom (`window.__vidroBoot` / `__vidroBootPending` /
  `DOMContentLoaded` fallback / idempotent guard)
- `declare global` で `Window` 拡張

これらは **全て framework 内部** で、user code が知る理由がない。ADR 0036 で
「TTI 改善のため shell trigger を使う」と決めたが、user space に漏らす理由は
なかった (= 早期に切り出すべきだった、後追い修正)。

### 3. `import.meta.glob` だけは user 側に残す (vite 制約)

```ts
boot(import.meta.glob("./routes/**/*.{ts,tsx}", { eager: true }));
```

`import.meta.glob` は **vite が compile-time に静的展開**する文字列 literal API。
helper 内に書いても vite plugin context が違うので展開されない (実行時に空オブジェクト)。
実質的に user 側で書かざるを得ない vite 制約。

将来的に `@vidro/plugin` で virtual module (例: `@vidro/routes`) を生やせば

```ts
import { boot } from "@vidro/router/client";
import { routes } from "virtual:vidro-routes";
boot(routes);
```

または auto-boot で

```ts
import "@vidro/router/auto-boot";
```

まで縮められる余地があるが、virtual module は plugin 工事 (ADR 0044 の scope
外) なので別 ADR / 別 PR で。

### 4. signature は **第 1 引数の `eagerModules` のみ**、override hook は YAGNI

最初は `boot(modules, { wrap?: (children) => Node })` で custom Provider 注入を
許す 2 引数 API も検討したが:

- 現状 user で wrap したい需要なし (vidro-tutorial / router-demo 両方とも
  `<Router />` 直で OK)
- 後方互換を保ったまま optional 第 2 引数を後で足すのは容易
- 早期 over-engineering は YAGNI に反する

→ minimal な 1 引数 signature で発進。需要が出たら拡張。

## 実装ファイル

新規:

- `packages/router/src/client.ts` — `boot(eagerModules)` 本体 (旧 main.tsx の
  ceremony を全部移植、`Router({routes, eagerModules})` 直接呼出。`h(Router, ...)`
  経由だと `ComponentFn = (props: Record<string, unknown>) => Node` と `RouterProps`
  の narrowing が通らず TS error。fine-grained reactive では `h()` 経由と直呼出は
  挙動同等 (内部で同じ `Component(props)` を実行) なので直呼出で十分)

修正:

- `packages/router/package.json` — `./client` export 追加、`build` / `dev`
  script に `src/client.ts` を entry に追加
- `apps/vidro-tutorial/src/main.tsx` — 40 行 → **2 行** (`import { boot }` +
  `boot(import.meta.glob(...))`)
- `apps/router-demo/src/main.tsx` — 同上、40 行 → 2 行

## 動作確認

- `vp dev` で vidro-tutorial: `/`, `/1` 全て SSR / hydrate OK (size 1777 / 1630
  bytes、移行前と完全一致)
- `vp dev` で router-demo: `/`, `/notes`, `/users` 全て SSR OK (size 3044 /
  4125 / 7655 bytes、移行前と完全一致 = regression なし)

## trade-off / 代替案検討

### A. main.tsx をそのまま残す (= 何もしない)

却下。`create-vidro` CLI で template として配布するときに毎 app この 40 行が
出てくるのは create-vidro 体験を損なう。`feedback_dx_first_design.md` の
「user が書くコードの見た目を起点に設計を見直す」原則と矛盾。

### B. plugin で virtual module を生やして `boot()` だけにする

将来検討。今は plugin 側の virtual module 機構が無く、新規実装コストが高い。
本 ADR の helper 切出しは下位互換性のある追加なので、virtual module 路線に
移行する時も `boot(routes)` の signature はそのまま使える。

### C. main.tsx 自体を完全自動化 (= user 側にファイルを置かない)

却下。Next.js は app router の `layout.tsx` / `page.tsx` を auto-discover し
main entry を持たないが、それを実現するには vite の HTML entry を plugin が
書き換える機構が必要。`index.html` の `<script src="/src/main.tsx">` を vite
が処理する標準フローから外れる工事になる (透明性損失、Hono 的透明性に反する)。

## follow-up

- virtual module 路線の検討 (`@vidro/routes` or `virtual:vidro-routes`)
- `boot()` の override hook (custom Provider / global error handler 等) は
  実需要が出たら 2nd 引数で追加 (signature 後方互換のまま拡張可能)
- create-vidro CLI 着手時に template `main.tsx` をこの 2 行に固定
