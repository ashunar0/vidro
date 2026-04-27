# ADR 0041 — navigation 単位で submission state を flush する

- Status: Accepted
- Date: 2026-04-27
- 関連 ADR: 0037 (R-min action), 0038 (per-key submission + programmatic submit), 0040 (submission.input)

## 背景 / 動機

ADR 0038 で `submission()` の per-key state (value / pending / error) を **module
scope の registry に永続** させることで、loader 自動 revalidate の component swap
を跨いで「Added: ...」表示が消えない Remix UX を成立させた。ADR 0040 で `input`
field を加えた今、同 registry が per-key で 4 つの signal を抱えている。

しかしこの永続性は **同 path 内の swap を跨ぐ範囲** に閉じておきたかった意図に
反して、**path 跨ぎの navigation でも残ってしまう** 副作用を持つ:

1. `/notes` で create form submit → `subCreate.value` に `{added: ...}` セット
2. Link で `/about` へ navigate
3. 戻る (popstate) で `/notes` に再到達
4. 古い `subCreate.value` がまだ生きていて、"Added: ..." が表示される

これは Remix の `useActionData()` の挙動 (= 新しい navigation に到達した時点で
null に戻る) と矛盾し、実利用時の混乱の元になる。

加えて、ADR 0038 の `dispatchSubmit` の redirect 経路 (= server が
`Response.redirect("/somewhere")` を返した) では `setResult` / `setError` を呼ばずに
そのまま `navigate(target)` する設計だった。registry は永続なので、redirect 先
(or redirect で戻ってきた同 path) で同 key の submission を読むと **古い value が
残っている** という挙動を残していた (ADR 0038 大論点 5 で受容した未解決事項)。

→ **本 ADR では「pathname が変わった瞬間に registry の全 entry の field を flush」**
する単純な policy を導入する。Remix UX と整合し、副菜として ADR 0038 の redirect
残存問題も自然に解消する。

## 設計判断

### Flush の単位: registry 全 entry / 値だけ flush

- 全 key を一律に flush する (= 「永続したい submission」escape hatch は今は実装しない、YAGNI)
- registry の Map entry **自体は削除しない**。signal identity を保持することで、
  既存の `effect(() => sub.value.value)` 等の subscriber を切らず、再度同 key で
  `submission()` が呼ばれた時に自然に空 state から再開できる
- flush 対象: `value=undefined` / `error=undefined` / `input=undefined` / `pending=false`
  (= `_resetRegistryForTest` と全く同じロジック)

### Flush タイミング: `currentPathname` の変化を effect で subscribe

- Router client mode mount 時に effect を 1 個追加
- `currentPathname.value` を読む → 変化のたびに `_clearAllSubmissionState()`
- **初回 invocation は skip** (= mount 時の初期 set / hydrate bootstrap で発火させない)
- 同 path への navigate / loader revalidate (`reloadCounter`) では発火しない
  - `navigate("/notes")` while at `/notes`: signal が同値 set で notify しない → skip
  - `reloadCounter += 1`: 別 signal なので clear 用 effect の dep に入らない → skip

### 実装場所

- `packages/router/src/action.ts`
  - `_clearAllSubmissionState()` を追加 (= `_resetRegistryForTest` と内部実装共有)
  - `_resetRegistryForTest` は test 用 alias として残す (= 既存 26 件 test 影響なし)
- `packages/router/src/router.tsx`
  - Router client mode の中で `effect(() => { /* pathname → clear */ })` を 1 つ追加
  - `skipFirstClear` フラグで初回 invocation skip
  - dispatcher 登録 / form delegation と同じく `onCleanup` で剥がれる

### opt-out (`persistent: true` 等)

- **今は実装しない**。toast や global notification 等の永続 use case が出てから
  別 ADR で追加する (YAGNI)
- 実装する場合の design memo: `submission(key, { persistent: true })` を受け、
  `_clearAllSubmissionState` 内で persistent flag が立った key だけ skip する形
  (registry entry に flag を 1 つ持たせれば足りる)

### 副菜: redirect 経路の value 残存

ADR 0038 で受容していた「redirect 後に古い value が残る」問題は、redirect の
`navigate(target.pathname + target.search)` で別 path へ移った瞬間に flush
されるため、本 ADR で **自然に解消** する (= bonus fix)。

ただし、**同 path への redirect** (`Response.redirect("/notes")` while at `/notes`)
では `navigate` が same-path で no-op となり flush されない。このケース自体が
レアで、しかも form 経路では bootstrapData 上書き + `reset()` (loader revalidate)
で fresh data に置換される。本 ADR では touch しない (= 必要になったら `dispatchSubmit`
の redirect 分岐で `mutator.setResult/setError` を呼ぶ別 ADR で扱う)。

### 副菜: in-flight submit の stale write-back guard (本 ADR で fix)

flush だけ入れても、**fetch 中に別 path へ navigate されたケースで write-back が起きる** 問題が残る:

1. `/notes` で submit → `dispatchSubmit` 内で `await fetch(...)` 中
2. user が Link / popstate で `/about` に navigate → flush で全 entry が `undefined` に
3. fetch resolve → `mutator.setResult(body.actionResult)` が **flush 済 registry に書き戻し**
4. `/about` の component が同 key で `submission()` を呼ぶと、古い「`/notes` の submit 結果」が見える

これは ADR 0041 の flush の意味論を破る挙動なので、本 ADR で同時に fix する。

`dispatchSubmit` 冒頭で `originPathname = currentPathname.value` を capture し、各 await 後に `currentPathname.value !== originPathname` なら早期 return する形 (`loadToken` パターンと同思想)。具体的には:

- fetch resolve 直後の path 比較
- body.json() の await 後にも path 比較 (二重 await の安全網)
- `catch` 節の AbortError 等の reject も同じく path 比較
- `finally` の `mutator.setPending(false)` も path 比較で guard。別 path 移動後は flush で `pending=false` 済なので skip する (= navigate 先で同 key を再 submit 中の `pending=true` を上書きしないため)

副作用として、navigate 中に submit が完了したリクエストの結果は **そのまま捨てる**。AbortController で fetch を実際に中断するのは別 ADR (Phase 4 step 2 候補)。

## lifecycle まとめ

| タイミング                                       | submission state 全 key                  |
| ------------------------------------------------ | ---------------------------------------- |
| 初期 (mount 直後 / hydrate)                      | 既存値を保持 (skip)                      |
| Link click / popstate / `navigate(別 path)`      | 全 key flush (value/error/input/pending) |
| `navigate(同 path)`                              | flush しない (signal 同値 set で no-op)  |
| `reset()` (= reloadCounter で loader revalidate) | flush しない (= 「Added: ...」維持)      |
| submit redirect → `navigate(別 path)`            | navigate 経由で flush                    |
| submit redirect → `navigate(同 path)`            | flush しない (既知の限界、別 ADR)        |
| Router unmount                                   | 何もしない (= cleanup で effect 剥がす)  |

## 実装ファイル

新規:

- `docs/decisions/0041-navigation-clears-submission-state.md` (本 ADR)

修正:

- `packages/router/src/action.ts`
  - `_clearAllSubmissionState()` を export 追加
  - `_resetRegistryForTest()` は内部 helper を共有する形に
- `packages/router/src/router.tsx`
  - client mode mount 内で `effect(() => { /* pathname → clear */ })` 追加
  - `dispatchSubmit` に `originPathname` capture + 各 await 後の path 比較 guard を追加 (副菜 fix)
- `packages/router/tests/submission.test.ts`
  - `_clearAllSubmissionState()` 直呼びの unit test 追加
- `packages/router/tests/router.test.tsx` (or 新規 router-action.test.tsx)
  - navigation で state が clear されること / 同 path navigate で残ること /
    初回 mount で flush されないこと の integration test 追加

## ADR 0038 / 0040 への追記

ADR 0038 の「state 永続」は本 ADR で **「同 path 内 swap 跨ぎの永続」** に意味を
縮小した、と読み替える。本 ADR の lifecycle 表を canonical にする。

ADR 0040 の `input` field も同 registry に住んでいるため、本 ADR の flush 対象に含む。

## 残課題 (本 ADR では touch しない)

- 同 path redirect の value 残存 (`Response.redirect("/notes")` while at `/notes`)
- registry entry leak (使い終わった key の Map entry が app 寿命まで残る、実害微少)
- `persistent: true` opt-out (toast / global notification 等の use case が出てから)
- 並列 submit の cross-contamination (ADR 0038 大論点 5)
- 別 Router 同時 mount での dispatcher 後勝ち (= 本 ADR の effect も後勝ちで上書きされる)
- AbortController による in-flight fetch の本物の中断 (今は完了結果を捨てるだけ)
- Router unmount 時の flush は意図的にしない (= 上の AbortController 整備と一緒に検討)
