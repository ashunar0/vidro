# ADR 0034 — ADR 0033 review feedback fixes (window resources / shell error / cross-boundary key warn)

- Status: Accepted
- Date: 2026-04-27
- 関連 ADR: 0030 (resource bootstrap), 0031 (streaming SSR shell+tail), 0033 (out-of-order full streaming)

## 背景

ADR 0033 着地後、`feature-dev:code-reviewer` agent によるレトロスペクティブ
レビューで 3 件の issue を指摘された。本 ADR で全て fix する。

## 採用方針 (要約)

1. **resources patch を `window.__vidroResources` object 化** (Issue 1)
2. **shell-pass throw を try/catch + `controller.error(err)` で明示** (Issue 2)
3. **cross-boundary 重複 `bootstrapKey` の dev warn 機構** (Issue 3)

## 論点と決定

### 論点 1: `__vidroAddResources` と `readVidroData()` の race

**問題**: `readVidroData()` は初回 call で `<script id="__vidro_data">` を parse + cache + **`el.remove()`** する。`__vidroAddResources` は毎回 `getElementById` で取って textContent を merge する。順序が崩れると後続 partial patch が **silent drop**:

- 速い boundary chunk → `__vidroAddResources({fast})` → DOM 書き換え
- 何らかで `readVidroData()` 呼ばれる → cache 確定 + `el.remove()`
- 遅い boundary chunk → `__vidroAddResources({slow})` → `el === null` で silent drop

現状 (DOMContentLoaded 待ち hydrate) では理論上踏まない (response 完全閉じ前に DOMContentLoaded 発火しないため)。が、ADR 0033 で明記した「将来段階 hydration の前提として partial 化」を踏むと **確実に地雷**。

**選択肢**:

- 案 A: `__vidroAddResources` で「`el` 無くなってたら諦め」を明示 + `readVidroData` で `el.remove` を遅延 → race window が縮むだけで根治しない
- **案 B (採用): `__vidroResources` を独立 window object に貯め、`readVidroData()` がそこから merge 読み**

採用案の動作:

```js
// VIDRO_STREAMING_RUNTIME 内
window.__vidroResources = window.__vidroResources || {};
window.__vidroAddResources = function (r) {
  for (var k in r) window.__vidroResources[k] = r[k];
};
```

```ts
// bootstrap.ts
function readVidroData() {
  if (cache !== undefined) return cache;
  // 1. <script id="__vidro_data"> から router 部分を parse + remove
  // 2. window.__vidroResources がある (streaming SSR 経由) なら
  //    parsed.resources に merge してから cache 確定
  ...
}
```

利点:

- `<script id="__vidro_data">` の DOM lifecycle と resources patch が **完全に独立**
- partial patch が cache 確定後に届いても、`window.__vidroResources` には入る
  → 将来段階 hydration で Resource constructor が `window.__vidroResources` を
  直接 lookup する mechanism を後付けできる (cache を bypass)
- 実装シンプル、size 増分も微量

欠点 / 残課題:

- 段階 hydration 化したとき、`Resource` constructor が **late-arriving resource を
  どう拾うか** は別途設計必要。本 ADR scope 外、`pending_rewrites` に追記
- `window.__vidroResources` の type 表明 (TypeScript で `declare global` する)
  は内部 API なので省略

### 論点 2: shell-pass throw の `controller.error` 明示

**問題**: ADR 0033 論点 6 は「shell-pass throw → `controller.error(err)`」と書いた
が、実装は try/catch 無しで WhatWG 仕様 (`start()` reject = stream errored) に
依存している。動作は同じだが、**明示性 / extender 混乱回避 / stack trace 情報**
の観点で明示する方がよい。

**選択肢**:

- 案 A: 現状維持 (動くから OK)
- **案 B (採用): `start(controller)` の中身を try/catch で囲んで `controller.error(err)` を明示**

採用理由: 5 行の追加で済む、ADR の記述と実装が一致する、将来 boundary-pass を
個別 try/catch する際の対称性が出る。

### 論点 3: cross-boundary 重複 `bootstrapKey` の dev warn

**問題**: `ResourceScope.registerFetcher` の dev warn は同一 scope 内のみ。out-of-
order では各 boundary が独立 scope を持つので、**異なる boundary 間で同じ
`bootstrapKey`** を使うと両方 register される → 両方 emit → client 側
`Object.assign` で後勝ち = **emit 順 (resolve 速度) で決まる非決定的動作**。

ユーザーが同じ key を意図せず複数箇所で使う事自体がバグだが、現状サイレント。
最低限 dev warn が必要。

**選択肢**:

- 案 A: 何もしない (ユーザーの責任)
- **案 B (採用): `StreamingContext` に key registry を持って shell-pass で
  cross-boundary 重複を detect → dev warn**
- 案 C: emit 時点で重複検出 (時系列が複雑、warn の出るタイミングがバラける)

採用案の動作:

```ts
export class StreamingContext {
  // 既存 (boundaries, allocBoundaryId, registerBoundary)
  ...
  /**
   * 各 boundary scope に register された key を全 boundary で track。
   * cross-boundary 重複は **shell-pass 終了後** に warn する (Suspense streaming
   * branch から呼ばれる、scope.fetchers が固まった時点)。
   */
  trackBoundaryKeys(scope: ResourceScope): void {
    for (const key of scope.fetchers.keys()) {
      if (this.#seenKeys.has(key)) {
        if (!this.#warnedKeys.has(key)) {
          console.warn(`[vidro] duplicate bootstrapKey "${key}" across Suspense boundaries — non-deterministic merge order`);
          this.#warnedKeys.add(key);
        }
      } else {
        this.#seenKeys.add(key);
      }
    }
  }
}
```

呼び出し箇所: `suspense.ts` streaming branch で `runWithResourceScope(boundaryScope, ...)`
で children 評価が終わった直後 (= scope.fetchers 確定タイミング)。

## 実装ステップ

| Step | 内容                                                                                                                                    |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `bootstrap.ts`: `readVidroData()` で `window.__vidroResources` を `parsed.resources` に merge                                           |
| 2    | `render-to-string.ts` `VIDRO_STREAMING_RUNTIME`: `__vidroAddResources` を window object 化                                              |
| 3    | `render-to-string.ts` `renderToReadableStream`: `start(controller)` を try/catch で囲って `controller.error(err)` 明示                  |
| 4    | `streaming-scope.ts` `StreamingContext`: `trackBoundaryKeys(scope)` 追加 + warn 機構                                                    |
| 5    | `suspense.ts` streaming branch: `runWithResourceScope` 評価後に `stream.trackBoundaryKeys(boundaryScope)` 呼出                          |
| test | 新規 test 3 件 — (a) cross-boundary 重複 warn / (b) shell-pass throw → stream errored / (c) `__vidroAddResources` が window object 経由 |
| test | 既存 `render-to-readable-stream.test.ts` の `__vidroAddResources({...})` 検出 assert を「window object 操作」に追従                     |

## 影響範囲

- `@vidro/core`: `bootstrap.ts` / `render-to-string.ts` / `streaming-scope.ts` /
  `suspense.ts`、それぞれ局所修正
- `@vidro/router`: 変更なし
- `apps/router-demo`: 変更なし

## 残課題 (project_pending_rewrites に追記)

- **段階 hydration 時の Resource constructor の late-arriving lookup**: ADR 0034
  で `window.__vidroResources` 化したので boundary chunk 経由で来た resource が
  cache 確定後でも window object に残る。Resource constructor が initial で
  bootstrap miss した場合に window object を後追い lookup する mechanism を、
  段階 hydration 着手時に設計する
