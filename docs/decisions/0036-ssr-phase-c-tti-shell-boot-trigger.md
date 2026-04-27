# ADR 0036 — SSR Phase C TTI 改善 (shell flush 直後 boot trigger + bundle async)

- Status: Accepted
- Date: 2026-04-27
- 関連 ADR: 0019 (hydrate primitive), 0027 (main.tsx hydrate 切替),
  0033 (out-of-order full streaming), 0035 (段階 hydration の機構整備)

## 背景 / 動機

ADR 0035 で段階 hydration の **機構** は完成した
(`__vidroPendingHydrate` registry / boundary 単位 hydrate runner /
late-arriving resource lookup)。しかし **TTI は依然 DOMContentLoaded 待ち**
だった。理由:

- `apps/router-demo/index.html` の bundle script が `<script type="module"
src="/src/main.tsx">` で **default の defer 動作** だから (HTML parse 完了 =
  最後の boundary chunk 受信完了まで実行されない)
- main.tsx は load されると即時 `hydrate(...)` を呼ぶ実装だったので、起点を
  早めるには main.tsx の load timing と shell DOM の可用性の両方を制御する
  必要がある

ADR 0035 は機構整備を完結させたが、起点 timing の改善はスコープ外として
本 ADR に切り出していた。本 ADR で「shell が DOM に乗った瞬間に hydrate を
起動する」経路を整える。

## 嬉しいこと

| metric                              | 改善する?    | 補足                                                                                             |
| ----------------------------------- | ------------ | ------------------------------------------------------------------------------------------------ |
| TTFB / FCP                          | No           | server 側、ADR 0033 までで完結                                                                   |
| **TTI (shell hydrate 起動 timing)** | **Yes**      | DOMContentLoaded 待ちが取れる。bundle が先着なら shell flush 直後に hydrate                      |
| Late boundary 単位 hydrate timing   | 副次的に Yes | shell hydrate が早く完了する分、後着 boundary fill 時の hydrate も早く回る                       |
| 既存 dev (`vp dev`) 経路            | No / 維持    | shell trigger は streaming SSR 経路でしか出ない。dev 経路は DOMContentLoaded fallback で従来通り |

## 設計判断

3 つの選択肢を比較し **A (shell 末尾 inline classic `<script>` + bundle
async + global registry)** を採用。

### 案 A (採用): shell 末尾 inline classic `<script>` + bundle async + registry

```html
<head>
  <script type="application/json" id="__vidro_data">
    …
  </script>
  <script>
    VIDRO_STREAMING_RUNTIME;
  </script>
  <!-- Vite が自動で `<head>` に hoist -->
  <script type="module" async crossorigin src="/assets/index-…js"></script>
</head>
<body>
  <div id="app">
    [shell markup …]
    <!-- shell flush 直後に core が 1 回 emit -->
    <script>
      window.__vidroBoot ? window.__vidroBoot() : (window.__vidroBootPending = true);
    </script>
  </div>
  [boundary chunks: __vidroAddResources / template / __vidroFill …]
</body>
```

- bundle (= `apps/router-demo/src/main.tsx` 由来の chunk) は `<head>` に
  `<script type="module" async>` で並列 download。`async` は parse-blocking
  なし、load 完了時点で実行
- main.tsx は `window.__vidroBoot = boot` を register する **だけ**。実 hydrate
  は trigger 経由で起動
- shell flush 直後の inline classic `<script>` (= `VIDRO_BOOT_TRIGGER`) が
  - bundle 先着 → `__vidroBoot()` を即発火 (= 後着 boundary より早い shell hydrate)
  - bundle 遅着 → `__vidroBootPending = true` flag (= bundle が後で load された
    時に main.tsx 側が flag を見て発火)
- registry idiom は ADR 0035 の `__vidroPendingHydrate[id]` と同じ pattern
  (race-safe な双方向 wakeup、認知負荷を増やさない)

### 案 B: shell 末尾 inline `<script type="module" async>`

`<script type="module" async>import('/assets/index-…js')</script>` を shell 末尾
に直書き。`type="module" async` は parse-blocking なしで load 完了次第即実行。

- 既存 main.tsx をほぼ無改修で動かせるが、shell に bundle path をベタ書きする
  必要がある
- bundle path は Vite の hash 化 (`index-QvpUdZsE.js` 等) と整合させる必要が
  あり、結局 plugin 経由で固定化 → 改修コスト増
- 採用しない

### 案 C: @vidro/plugin の `transformIndexHtml` で `<script>` 配置を完全制御

build 時に `<script>` の type / async / 配置位置を plugin が書き換え + shell
streaming との協調 logic を plugin に持たせる。

- 制御点が 1 箇所に集約できる利点あり
- だが本 ADR の目的 (TTI 改善) には plugin 改修まで踏み込む必要がない
- plugin が server-side streaming の chunk 構造を意識する必要が出るので、抽象
  漏れが大きい (= 別 ADR でやる時に検討)
- 採用しない

## 実装

### 1. `packages/core/src/render-to-string.ts`

`renderToReadableStream` の `start(controller)` 内、shell-pass `emit(shellHtml)`
の **直後** で boot trigger を 1 回 enqueue。後着 boundary chunks より前に並ぶ
順序が API レベルで保証される。

```ts
emit(shellHtml);
emit(VIDRO_BOOT_TRIGGER);
// 2. boundary 並列 flush + root scope flush …
```

新規 export `VIDRO_BOOT_TRIGGER` (`packages/core/src/server.ts` に追加):

```ts
export const VIDRO_BOOT_TRIGGER = `<script>window.__vidroBoot?window.__vidroBoot():(window.__vidroBootPending=true);</script>`;
```

- classic (non-module) inline `<script>`、size ~80B
- `type="module"` を使わない理由: module script は default で defer 相当 (HTML
  parse 完了待ち)。即時実行が必要なので classic 一択
- minify はしない (size 小、可読性優先)

### 2. `apps/router-demo/src/main.tsx`

即時実行から **boot registry 化** に変更。dev / prod 両対応の trampoline:

```ts
let booted = false;
const boot = (): void => {
  if (booted) return;
  booted = true;
  hydrate(() => <Router routes={routes} eagerModules={eagerModules} />, root);
};

window.__vidroBoot = boot;
if (window.__vidroBootPending) {
  delete window.__vidroBootPending;
  boot();
} else if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}

declare global {
  interface Window {
    __vidroBoot?: () => void;
    __vidroBootPending?: boolean;
  }
}
```

- `booted` flag で多重発火ガード (idempotent)
- 三分岐:
  - `__vidroBootPending` → trigger 先着済み = bundle 遅着経路 → 即発火 (delete してから)
  - `document.readyState === "loading"` → bundle 先着 + HTML parse 中 = trigger
    が後で来るのを待つか、来ないなら DOMContentLoaded fallback (dev 経路)
  - それ以外 → HTML parse 完了済み + trigger 不在 (= dev で main.tsx 遅延読込
    したケース等) → 即発火

### 3. `apps/router-demo/index.html`

`<script type="module" src="/src/main.tsx">` に `async` 属性を追加。

```html
<script type="module" async src="/src/main.tsx"></script>
```

Vite build はこれを `<head>` に自動 hoist し、`crossorigin` を付ける:

```html
<script async type="module" crossorigin src="/assets/index-…js"></script>
```

これで bundle が並列 download される。

## 検証

### unit test (新規 2 件 / 既存 1 件 augment)

`packages/core/tests/render-to-readable-stream.test.ts`:

- ADR 0036: `VIDRO_BOOT_TRIGGER` は registry idiom を含む (`__vidroBoot` /
  `__vidroBootPending`)、classic script (= `type="module"` 不在)
- ADR 0036: boundary 無し (shell のみ) でも boot trigger は emit される
- 既存「Suspense + bootstrapKey」test に boot trigger の **位置 assertion** を
  追加: shell の boundary marker より後 / boundary fill より前

10/10 全 pass。

### 実機検証 (wrangler dev + Playwright)

`/streaming-demo` (slow 800ms / fast 100ms boundary):

- `<head>` に `<script async type="module" crossorigin>` が hoist される ✓
- shell HTML 内の `</div>` 直前に boot trigger script が 1 回出る ✓
- 後着 boundary chunks (`__vidroAddResources` / template / `__vidroFill`) は
  trigger より後ろに並ぶ ✓
- ブラウザ navigation 後:
  - `window.__vidroBootPending`: undefined (delete 済み) ✓
  - `window.__vidroBoot`: function ✓
  - `window.__vidroPendingHydrate`: `{}` (全 boundary hydrate 完了) ✓
  - slow / fast 両 content が resolved 値で表示 ✓
  - fallback element 消失 ✓
  - console error / warning 0 ✓

## Trade-off / 残課題

### `__vidroBootPending` の race window

shell trigger と main.tsx の register が完全並列で動く以上、register 直前に
trigger が走り、register 直後に flag を見るのは micro race window がある。
本 ADR の三分岐は **register → flag check** の順なので race は無い (= flag
が立ってれば必ず checkable)。

### dev (`vp dev`) 経路は TTI 改善されない

dev は `apps/router-demo/vite.config.ts` 経由で Vite dev server が直接 index.html
を serve する。`createServerHandler` の navigation handler は dev では
`@vidro/plugin` の `serverBoundary` middleware 経由で部分的に呼ばれるが、shell
streaming 経路は通らない (= boot trigger が出ない)。main.tsx は
DOMContentLoaded fallback で boot するので動作はする。

dev でも streaming SSR を回す (= production-like dev) のは別 ADR (Vite plugin
の dev/prod 整合作業)。

### bundle hash 名と inline script の整合

本 ADR では bundle path 知識を server (router/server.ts) や core (render-to-string.ts)
に持たせない設計 (= registry 経由で path 不要)。Vite が生成する bundle path は
`index.html` 経由でしか参照されない。これを崩さない限り bundle hash 化問題は
発生しない。

### `<head>` hoist の Vite build 依存

`apps/router-demo/index.html` は `<script type="module" async src="/src/main.tsx">`
を `<body>` 末尾に書いているが、Vite build (v8 系で確認) が build 時に **`<head>`
へ自動 hoist** する挙動に依存している (= bundle が HTML parse 開始と同時に並列
download されるための前提)。

リスク: Vite version upgrade、`@vitejs/plugin-legacy` 等の追加、`build.modulePreload`
設定変更などで hoist 動作が変わる可能性がある。

**フォールバック動作**: hoist されず `<body>` 末尾に残った場合でも `async` の
fetch trigger 自体は変わらないが、HTML parser が body 末尾まで進まないと fetch
開始されない (= shell 受信中の time window で並列 download できない)。TTI 改善
効果は減衰するが、boot の正確性 (idempotency / DOMContentLoaded fallback) には
影響しない。

**revisit trigger**: Vite version upgrade 時、または `dist/index.html` の生成物で
`<head>` hoist が確認できなくなった場合。確認方法は `vp build` 後に
`apps/router-demo/dist/index.html` で `<head>` 内に `<script async type="module" crossorigin>`
が含まれることを目視。

### Network throttle 下の挙動

local wrangler では bundle と shell の到着順は network 速度次第で race。
本実装は両経路 (bundle 先着 / 遅着) どちらでも boot は idempotent に発火する。
slow network で実体感する TTI 改善は別途 chrome devtools の network throttle
で手動確認可能 (本 ADR では未実施)。

### bundle 自体のサイズは変わらない

`<head>` async は parallel download を有効化するだけで、bundle code 自体は
変わらない。Phase 4 以降の code splitting / route-level lazy loading は別案件。

## 結論

- shell flush 直後 inline classic `<script>` (boot trigger) + bundle `<head>`
  async + main.tsx の registry trampoline で、shell が DOM に乗った瞬間に
  hydrate を起動できる経路を整えた
- ADR 0035 の段階 hydration 機構がそのまま乗る (boundary chunk 単位 hydrate も
  早期に始まる)
- 既存 dev 経路は DOMContentLoaded fallback で従来動作を維持
