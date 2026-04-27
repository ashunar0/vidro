# ADR 0035 — SSR Phase C 段階 hydration の機構整備 (cursor 切り出し / late-arriving resource lookup)

- Status: Accepted
- Date: 2026-04-27
- 関連 ADR: 0019 (hydrate primitive), 0029 (Suspense), 0030 (resource bootstrap),
  0031 (streaming SSR shell+tail), 0033 (out-of-order full streaming),
  0034 (window resources / shell error / cross-boundary key warn)

## 背景 / 動機

ADR 0033 で out-of-order full streaming SSR が着地し、ADR 0034 で
`window.__vidroResources` の足場を作った。しかし client 側 hydrate は依然
**全 chunk 受信完了 (= DOMContentLoaded) 後に root から 1 回**。speed の
streaming は活きてるが「shell が早く届いても hydrate は最後の boundary 待ち」
という機構的な天井が残っている。

本 ADR では「段階 hydration」(boundary chunk fill のたびに該当部分を hydrate)
の **機構整備** を行う。**TTI 改善は本 ADR の目的ではない** — それには
`<script type="module" defer>` の挙動 (DOMContentLoaded 待ち) を変える bundle
構造改修が必要で、別 ADR で扱う。本 ADR は、その別 ADR が乗れる土台を作るのみ。

## 何が嬉しい (= 本 ADR で取れるもの / 取れないもの)

| metric                                         | 改善する?            | 補足                                                                    |
| ---------------------------------------------- | -------------------- | ----------------------------------------------------------------------- |
| TTFB / FCP                                     | No                   | server 側、ADR 0033 までで完結                                          |
| TTI (体感操作可能まで)                         | **No (本 ADR では)** | bundle 改修 ADR が乗らない限り出ない                                    |
| 機構の整備                                     | **Yes**              | cursor 切り出し / late-arriving lookup / boundary 単位の hydrate runner |
| Resource cache 確定後の後着 patch を引き当てる | **Yes**              | C-α (window object 直接 lookup)                                         |
| 段階 hydration の test 可能性                  | **Yes**              | boundary 単位の hydrate を関数として呼べる形にする                      |

## 解決すべき根本問題

`HydrationRenderer` は target subtree を post-order で flatten した **単一 cursor**
を持つ (`hydration-renderer.ts:postOrderNodes`)。Suspense streaming branch では
shell に **fallback markup しか入っていない** ので、client mode の Suspense が
通過時に「children を JSX 評価」しようとすると、cursor は fallback を消費する
方に進んでいるため、children 評価で必ず mismatch する。

→ **cursor を boundary 単位に切り出す必要がある**。

## 採用方針 (要約)

1. **α: cursor 切り出しは「別 Renderer 案」**
   shell hydrate run は Suspense 通過時に children を **closure として hold**
   (評価しない、cursor 進めない)。boundary fill 後に **新しい HydrationRenderer**
   を boundary 範囲の DOM で作って children を hydrate する。

2. **B-α: boundary 範囲は start/end marker を残して特定**
   `__vidroFill(id)` を改修。template 差し替えは現状通りだが、`<!--vb-${id}-start-->`
   `<!--vb-${id}-end-->` を **remove せず保持**。段階 hydration runner が
   `start.nextSibling ... end.previousSibling` を target にする。markup +30 byte/boundary。

3. **C-α: Resource は `window.__vidroResources` を直接 lookup**
   `bootstrap.ts` の cache 経由ではなく、Resource 専用の `readResourceBootstrap(key)`
   を作って `window.__vidroResources` を見る。cache 確定後に届いた boundary chunk
   の resources も引き当てられる (= late-arriving 対応)。Router 系の固定値 field
   (`pathname`/`params`/`layers`) は従来の `readVidroData()` 経由のまま。

4. **boundary registry & hydrate trigger を core に新設**
   `StreamingHydrationContext` (新規 module-level state) に `registerBoundary(id, factory)` /
   `flushPending()` を持たせる。`hydrate()` が streaming markup を検出したら本 context
   を active にして shell hydrate を回す。`__vidroFill(id)` 末尾で
   `window.__vidroPendingHydrate[id]?.()` を呼んで boundary children を hydrate。

## 論点と決定

### 論点 1: cursor 切り出し (α 採用)

**選択肢**:

- α: shell hydrate と boundary hydrate で **別の HydrationRenderer instance** を作る
- β: 単一 Renderer で cursor を push/pop する stack 機構

**採用: α**。理由:

- 既存 `createHydrationRenderer(target)` は target を受け取る形なので、α は
  「もう 1 回呼ぶ」だけで済む。既存コードへの侵入が小さい
- Renderer state を独立に持てる (boundary 内 mismatch が shell 側に波及しない)
- β は cursor の状態管理が脳に厳しい

### 論点 2: boundary 範囲の特定 (B-α 採用)

**問題**: 段階 hydration runner は「ここから ここまでが boundary の中身」を
DOM 上で見つける必要がある。fill 後の DOM には目印が `<!--suspense-->` anchor
しか残らないと、anchor から `previousSibling` を巻き戻すしかなく、複数 sibling
があるとどこで止めるかが曖昧。

**選択肢**:

- B-α: `__vidroFill` で start/end marker を remove せず残す
- B-β: 現状通り remove、anchor から逆探索

**採用: B-α**。理由:

- markup +30 byte/boundary は安い (= 確実性とのトレードで割安)
- 範囲が明示的 → エッジケース無し / test の assertion がストレート
- B-β は `<h1>...</h1><Suspense>...</Suspense>` のように Suspense 外の sibling
  と混ざるリスクがある

### 論点 3: Resource の late-arriving bootstrap lookup (C-α 採用)

**問題**: `readVidroData()` は初回呼び出しで cache 確定。shell hydrate run で
Router が先に `readVidroData()` を呼ぶと、cache は **その時点の** `window.__vidroResources`
snapshot で固まる。あとから届いた boundary chunk が `window.__vidroResources` に
書き込んでも、cache.resources には反映されない → Resource が miss → blink。

**選択肢**:

- C-α: Resource 専用の `readResourceBootstrap(key)` で **毎回 `window.__vidroResources` を直接見る**
- C-β: `readVidroData()` を呼ぶたびに cache.resources を re-merge
- C-γ: cache.resources だけ getter にする

**採用: C-α**。理由:

- ADR 0034 で「window object が SSOT」と決めた延長で素直
- 関心の分離: Router 系 (固定値) は cache 経由、Resource 系 (動的) は window 直接
- `readVidroData()` の意味論を変えない (他 caller 影響なし)
- 性能: lookup 1 回 / Resource 構築あたり、無視できる

```ts
// resource.ts
function readResourceBootstrap(key: string): BootstrapValue | undefined {
  // streaming runtime が active なら window object に最新 resources がある (後着 patch も含む)
  if (typeof globalThis !== "undefined") {
    const stream = (globalThis as { __vidroResources?: Record<string, BootstrapValue> })
      .__vidroResources;
    if (stream && key in stream) return stream[key];
  }
  // streaming runtime 不在 (Phase A/B SSR or non-streaming) は cache 経由 fallback
  const data = readVidroData();
  return (data?.resources as Record<string, BootstrapValue> | undefined)?.[key];
}
```

### 論点 4: shell hydrate run の Suspense 挙動

streaming markup を hydrate する時、Suspense は **shell run では children を評価しない**
ようにしたい (cursor 過剰消費の回避)。

**判定方法**:

- `HydrationRenderer` に `streaming: boolean` flag を持たせる
  (`createHydrationRenderer(target, { streaming: true })`)
- `hydrate()` 呼び出し時に target subtree を簡易 scan して `<!--vb-*-start-->`
  comment があれば streaming SSR markup と判定
- Suspense は `renderer.streaming === true` を見て分岐:
  - true: fallback だけを cursor 消費、children は closure として `getCurrentStreamingHydration()` の registry に push、start/end marker を comment Node として cursor 消費
  - false (現状): children を評価 / pending なら fallback も評価 (現状の client mode 動作)

**alternative (採用しない)**: hydrate に new option (`streaming: true`) を渡す API。
→ 自動 detect の方が user 側の API surface が小さい。toy 段階では auto を採用、
将来 hint が必要なら option 経由に拡張。

### 論点 5: shell hydrate 完了後の boundary hydrate trigger

shell hydrate が終わった時点で、boundary chunk の到達状況は 2 通り:

1. **既に fill 済み** (= boundary chunk が shell hydrate より先に DOM に入った):
   `<!--vb-${id}-start-->` の直後にもう resolved markup が入っている。
   → 即 `hydrateBoundary(id, factory)` を呼ぶ
2. **未着** (= まだ fill されていない):
   `<!--vb-${id}-start-->` の直後はまだ fallback markup のまま。
   → `globalThis.__vidroPendingHydrate[id] = () => hydrateBoundary(id, factory)`
   として保留。`__vidroFill(id)` 末尾で発火される

**判定方法**: `<!--vb-${id}-start-->` の `nextSibling` が `<!--vb-${id}-end-->`
かどうかでは判定不能 (fill 済みでも middle に Node があるとき同様)。
代わりに registry 自体が「fill 済みかどうか」を知る必要があるか?

→ シンプル化: **`__vidroFill(id)` は冪等に hydrate を呼ぶ。fill 済みかどうかは
runtime 側で気にしない**:

- 案 A: shell hydrate 完了時に、まだ pending な registry entry を `__vidroPendingHydrate`
  に書き出す。`__vidroFill` が後で呼べば走る
- 案 B: `__vidroFill` 自体を 2 回呼びうる前提にして、pending registry を flush 経由で
  消化する

**採用: 案 A**。実装シンプル、`__vidroFill` の挙動は今より複雑にしないで済む。

### 論点 6: TTI 改善は別 ADR (本 ADR scope 外)

shell が届いた瞬間に shell hydrate を走らせるには `<script type="module" defer>`
を変える必要がある (例: `<script>` を inline 化、shell の末尾で `hydrate(...)` を
trigger する snippet を入れる、worker で stream chunks ごとに hydrate run を回す等)。
これは bundle 構造 + Vite plugin 周りの大改修。

本 ADR では機構だけ揃えて、別 ADR (= TTI 改善 ADR) が以下のように差し込めるよう
にしておく:

- shell の末尾で `hydrate(() => <App />, root)` を inline で呼べる
- 既存の boundary registry / `__vidroPendingHydrate` mechanism がそのまま動く

→ **`project_pending_rewrites.md` に「shell hydrate 先行発火 (TTI 改善) 別 ADR」を追記**。

## 実装ステップ

| Step | 内容                                                                                                                                                                                                                                                                                                                                            |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `streaming-hydration.ts` 新規: `StreamingHydrationContext` + `registerBoundary` / `flushPending` / `runWithStreamingHydration`                                                                                                                                                                                                                  |
| 2    | `hydration-renderer.ts`: `createHydrationRenderer(target, { streaming?: boolean })` に拡張、Renderer に `streaming` flag を生やす                                                                                                                                                                                                               |
| 3    | `hydrate.ts`: target subtree に `<!--vb-*-start-->` があれば streaming mode で起動、`StreamingHydrationContext` を立てて shell run、終了後に `flushPending`                                                                                                                                                                                     |
| 4    | `suspense.ts` client mode: `renderer.streaming === true` 分岐で children を closure 化 + registry push、fallback だけ cursor 消費、start/end marker を cursor 消費                                                                                                                                                                              |
| 5    | `resource.ts`: `readResourceBootstrap(key)` を window object 直接 lookup に変更 (C-α)                                                                                                                                                                                                                                                           |
| 6    | `render-to-string.ts` `VIDRO_STREAMING_RUNTIME`: `__vidroFill` で start/end marker を **remove しない** + 末尾で `__vidroPendingHydrate[id]?.()` 発火 + `__vidroPendingHydrate` 自体の初期化                                                                                                                                                    |
| 7    | boundary 単位 hydrate runner (`hydrateBoundary`): start/end 間を target subtree にして新 HydrationRenderer で children factory を run                                                                                                                                                                                                           |
| test | 新規 test 4-5 件 — (a) shell hydrate で Suspense 通過時に children が呼ばれない / (b) `__vidroFill` で start/end marker が残る / (c) boundary fill 後に children が hydrate されて event listener が attach される / (d) Resource が late-arriving (cache 確定後) でも引き当てる / (e) shell hydrate 完了時点で fill 済み boundary は即 hydrate |
| test | 既存 `render-to-readable-stream.test.ts` の marker 周辺 assertion を marker 残置に追従                                                                                                                                                                                                                                                          |

## 影響範囲

- `@vidro/core`:
  - 新規: `streaming-hydration.ts`
  - 修正: `hydration-renderer.ts`, `hydrate.ts`, `suspense.ts`, `resource.ts`,
    `render-to-string.ts` (`VIDRO_STREAMING_RUNTIME`)
  - export: `_$hydrateBoundary` 等 internal 関数を index に出すかは検討 (テスト用のみなら hidden export)
- `@vidro/router`: 変更なし
- `apps/router-demo`: 変更なし (実機検証 `/streaming-demo` のみ)

## review fix (内蔵)

`feature-dev:code-reviewer` でレビュー実施、Critical 1 / Important 2 / Worth 3 を
全件 fix:

- **#2 (Critical)**: `flushPending` の `!pending` fallback path が **未 fill な
  boundary に対して `tryHydrateBoundary` を即時呼ぶ** 実装で、cursor mismatch で
  throw する地雷だった。`isBoundaryFilled` check を `!pending` branch にも入れて、
  fill 済みのみ即時 hydrate / 未 fill + runtime 不在 = silent skip に修正
- **#5 (Important)**: boundary `tryHydrateBoundary` の root Owner に effect leak
  懸念 (event listener leak ではなく、long-lived signal subscriber list 経由で
  Owner が GC されない)。本 ADR では受容、コメントで明示。boundary 単位 dispose
  API は別 ADR (`project_pending_rewrites.md` に追記)
- **#6 (Important)**: `isBoundaryFilled` の `typeof document === "undefined"` guard
  欠落 (`findCommentMarker` と inconsistent)。1 行 fix
- **#7 (Worth)**: `tryHydrateBoundary` で start/end marker が見つからない時の
  silent return を console.warn 化 (server / client 採番 desync の dev assertion)
- **#8 (Worth)**: `!pending` fallback path の test coverage を追加
  (`streaming-hydration.test.ts` に 2 件 + dev assertion test 1 件)
- **#9 (Worth)**: `readResourceBootstrap` のコメント wording を修正
  (window object の存在ではなく key 不在を fallback 条件として書く)

## 残課題 (`project_pending_rewrites.md` に追記)

- **TTI 改善 (shell hydrate 先行発火)**: 本 ADR は機構整備のみ。bundle 構造を
  変えて shell の末尾で hydrate を呼ぶ別 ADR で取り扱う。本 ADR の registry /
  `__vidroPendingHydrate` mechanism がそのまま乗る形にしてある
- **boundary 単位 dispose / Owner 親リンク化**: 現状 `tryHydrateBoundary` は root
  Owner (parent=null) を作るので、effect が long-lived signal を購読すると
  subscriber list 経由で Owner が GC されない (= leak)。
  router navigation で boundary が頻繁に作られる app では見過ごせなくなる。
  対応するには boundary owner を hydrate root の Owner と connect する +
  boundary 単位の dispose API を導入する必要がある
- **nested Suspense の段階 hydration**: 内側 Suspense は streaming chunk 化されて
  いない (true full out-of-order と組案件)。本 ADR では外側 boundary に内側を
  巻き込む形のまま (= 内側はそのまま children として hydrate される)
- **shell-pass error → Phase A degrade**: shell render を sync 段階で先行実行
  する 2 段階 API に再設計する別案件。本 ADR scope 外
- **shell hydrate 中の fallback hydrate**: 本 ADR では shell hydrate の Suspense
  streaming branch で fallback を **評価せず** boundary range を skip する設計
  (cursor mismatch 回避のため)。fallback の event listener / effect は attach
  されない trade-off。短期表示なので実害は小さいが、fallback 内に interactive な
  UI を置きたい user 要求が来たら別 ADR で対応 (= 単一 cursor を pause / resume
  する stack 機構 or fallback 専用 sub-cursor)
