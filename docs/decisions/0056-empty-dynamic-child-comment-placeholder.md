# 0056 — empty な dynamic child を Comment placeholder で吸収する

## Status

**Accepted** — 2026-05-03 (48th session、user 合意取得済 + reviewer agent fix 反映済)

依存: ADR 0019 (`_$dynamicChild` の post-order 化)、ADR 0055 (text/expr boundary marker、同型の Comment 機構)

## Context

### 痛みの起点 — `/broken` page の hydrate mismatch

`apps/router/src/routes/broken/index.tsx` (= 意図的 throw) → ErrorBoundary → `routes/error.tsx` (RootError) fallback の hydrate で console error が出ていた (memory `project_pending_rewrites`、46th 繰越)。

```
[hydrate] text mismatch: expected "", got "Retry"
[hydrate] cursor mismatch: expected text "Retry", got <button> at index 22
```

発火箇所は `error.tsx` の React 風 conditional render:

```tsx
{
  Object.keys(params).length > 0 && (
    <p>
      Params: <code>{JSON.stringify(params)}</code>
    </p>
  );
}
```

`params={}` なら式は `false` を返す。

### 構造的な原因 — 3 段の連鎖

1. **JSX transform** (ADR 0019/0025): intrinsic 親内の非 Element 式は `_$dynamicChild(() => expr)` で wrap される。LogicalExpression / ConditionalExpression も例外なし
2. **`_$dynamicChild` の現状**: peek した値を `toText()` で文字列化 → `r.createText(toText(peeked))` で Text Node を 1 個必ず emit。`toText(false)` / `toText(null)` / `toText(undefined)` / `toText(true)` / `toText("")` はすべて `""` を返す → **空文字 Text Node**
3. **HTML serializer**: VText `""` を `escapeText("")` = `""` で emit。HTML markup 内に Text Node の痕跡が **0 byte** で消える。HTML parser も「無いものは無い」として何も起こさない

→ server emit: 「Text Node 1 個出すつもり」(`createText("")`)
→ HTML markup: 何もない (`</p><button>`...)
→ client cursor: Text Node 1 個 expect → 次に来る Text Node を消費 → `<button>` 内の `"Retry"` を掴む → data 不一致 warn + cursor 1 個食いすぎ → 続きで `<button>` 期待が来る前に cursor が `<button>` を指す → 連鎖で全部巻き込み throw

### 影響範囲

ユーザーが普通に書く React 風 conditional render は全部踏む:

```tsx
{
  user && <Profile user={user} />;
}
{
  count > 0 ? <Badge>{count}</Badge> : null;
}
{
  loading ? "Loading..." : "";
}
{
  /* 文字列の "" も同罪 */
}
{
  message;
}
{
  /* message が初期 "" だとアウト */
}
```

memory `project_legibility_test`: 普通に読めれば OK の magic 許容ライン
→ user に「`{x && <p/>}` でなく `<Show when={x}><p/></Show>` を使え」を強制するのは legibility test に近接する。conditional render は React mental model の核。

### ADR 0055 との関係

ADR 0055 は **adjacent text/expr boundary** に separator comment を入れて HTML parser merge を回避する話。本 ADR 0056 は **dynamic child の peek 結果が empty なケース** を Comment placeholder で吸収する話。両者は

- 目的が違う (parser merge 回避 vs empty Text 消失回避)
- どちらも `<!---->` という 4 byte の empty Comment を使う (機構は同型)
- 衝突しない (anchor `<!--show-->` 等とも衝突しない、ADR 0055 Open Question 1 と同じ理屈)

→ 0055 で導入した Comment placeholder pattern の **第 2 用途** として 0056 が生える。

### 同種問題の他 FW 解決策

| FW              | 仕組み                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------ |
| **Solid**       | dynamic 挿入位置に marker comment を予め埋める。empty でも marker は残る                   |
| **React** (18+) | hyperscript / VDOM、SSR 時 falsy child は `<!--$?-->` 等の Suspense marker や empty で吸収 |
| **Marko**       | template-based。dynamic 位置は `<!---->` で marker                                         |
| **Svelte**      | 同上                                                                                       |

→ 「empty を Comment placeholder で吸収」も FW 界の標準ツールキット。

## Options

### (A) `_$dynamicChild` の peek 段階で empty 判定 → Comment placeholder

```ts
// _$dynamicChild の primitive path
if (toText(peeked) === "") {
  return _emptyDynamicSlot(r, thunk); // Comment placeholder + swap effect
}
```

- runtime 側 1 ファイル fix。transform 側触らない
- effect で `"" → 非空` 遷移を comment ↔ text の DOM swap で吸収 → reactivity 維持
- server は `r.isServer` 早期 return で effect skip (= 初期 emit のみ)
- `<!---->` が常に SSR/hydrate で emit されるので cursor symmetric
- 既存 anchor (`<!--show-->`, `<!--for-->` 等) と value="" Comment は衝突しない (predicate は nodeType だけ check)

### (B) JSX transform で LogicalExpression / ConditionalExpression を別 helper に振り分け

```ts
// transform 後
{x && <p/>} → _$conditionalChild(() => x && <p/>)
```

- 識別が syntax-level で限定的 (LogicalExpression / ConditionalExpression のみ)
- 本質の問題 (empty Text Node) は他の peek でも起きる: `{message}` で message が `""` の場合
- 結局 runtime 側でも判定が必要、transform 側だけでは不十分

### (C) serializer で VText `""` を `<!---->` に置き換え

- `serialize()` で `node.value === ""` → `<!---->` emit
- でも client / hydrate 側の `createText("")` は依然 Text Node を期待 → mismatch のまま
- 両側 (renderer + serializer) を整合させる必要 → 結局 (A) より広い変更

### (D) 何もしない

- `<Show>` を user に強制
- legibility test 違反、dogfood で大量に踏む UX

## Decision

**(A) `_$dynamicChild` の peek 段階で empty 判定 → Comment placeholder** を採用する。

### 挿入条件

`_$dynamicChild(thunk)` で:

1. `untrack(thunk)` で peek
2. function auto-invoke (ADR 0026 既存挙動)
3. Array / Node / Signal の各 special case を従来通り処理
4. **新規**: `toText(peeked) === ""` なら `_emptyDynamicSlot(r, thunk)` に分岐
5. 残りは従来通り Text Node + effect

`Signal` branch も初期値が空文字なら同様に `_emptyDynamicSlot` を呼ぶ (Signal を thunk 化して渡す)。

### `_emptyDynamicSlot` の挙動

```ts
function _emptyDynamicSlot(r, thunk): Node {
  const placeholder = r.createComment("");
  if (r.isServer) return placeholder; // server は effect skip

  let current: Node = placeholder;
  effect(() => {
    const next = toText(unwrap(thunk()));
    const isComment = current.nodeType === 8;
    // ⚠️ effect 内では getRenderer() を毎回呼ぶ (review #2 で発見した bug の対策)。
    // hydrate 中に install された effect は hydrate 完了後に signal 変化で再実行されるが、
    // 引数 r を closure で掴むと「stale な HydrationRenderer」を呼んで cursor exhausted で
    // throw する。getRenderer() 経由なら hydrate 後 (= setRenderer で browserRenderer に戻る)
    // の再実行も安全。
    const active = getRenderer();
    if (next === "") {
      if (!isComment) {
        const replacement = active.createComment("");
        current.parentNode?.replaceChild(replacement, current);
        current = replacement;
      }
      return;
    }
    if (isComment) {
      const replacement = active.createText(next);
      current.parentNode?.replaceChild(replacement, current);
      current = replacement;
    } else {
      active.setText(current, next);
    }
  });
  return current;
}
```

server: `isServer` 早期 return で初期 Comment のみ emit。serialize で `<!---->` が出る。
hydrate: `r.createComment("")` が cursor から Comment を消費。effect が install され、以降の reactive update には `getRenderer()` 経由で active な browserRenderer を取って swap する (= hydrate 終了後の signal 変化に追従)。
client: 新規 Comment Node を作る。初期 effect 評価で peek と一致するので no-op。後続の signal 変化で swap。

### 既存挙動との互換

- `<p>{count.value}</p>` で count が `0` → `toText(0) = "0"` → 空文字でない → 従来通り Text Node。**regression なし**
- `<p>{message}</p>` で message が `""` → 空文字 → Comment placeholder + effect で swap。client only モードで `""` → `"hello"` 遷移時は effect が DOM swap で text node に差し替える
- `<p>{cond && <X/>}</p>` で cond falsy → Comment placeholder。cond が後で truthy になっても **Node ↔ primitive の toggle は引き続き未対応** (既存制約、`<Show>` を使う)

### 挿入しないケース

- Array / Node / Signal の各 branch は従来通り (empty 判定なし)
- `_$text("")` (literal text) は対象外: literal "" は cleanJSX で消えるはずで、生 `_$text("")` は手書き path のみ。本 ADR は `_$dynamicChild` 限定

## Consequences

### Pros

- React 風 conditional render (`{x && <X/>}` / `{x ? <X/> : null}`) が legibility test 死守状態で hydrate 整合
- runtime 1 関数 fix、transform 側ゼロ変更
- server +4 byte (`<!---->`) のみ、bundle 影響軽微
- ADR 0055 の Comment placeholder 機構を再利用、新規概念ゼロ

### Cons / Open Questions

- **Node ↔ primitive の toggle は未対応**: `{cond && <p/>}` で cond が後で truthy になっても、effect 内で `toText(<p>)` は `""` (object → 空文字) なので comment のまま。これは ADR 0019 + `toText` の既存制約で、本 ADR で導入する regression ではない
  - `<Show>` を使えば node toggle 可能
  - 将来 `_$dynamicChild` の primitive path で「peek が Node なら append child としてマウント、effect で children 差し替え」を実装するなら本 helper も拡張する
- **swap effect の DOM mutation**: `parent.replaceChild` を直接呼ぶ (renderer 抽象を bypass)。server は早期 return で踏まないので無害。renderer interface に `replaceNode` を生やす案もあるが、boundary が 1 箇所なので YAGNI
- **既存 anchor との value="" 衝突**: ADR 0055 と同じ — `Show` / `Switch` / `For` 系は value="show" 等の non-empty value を持つので、value="" Comment との predicate 衝突なし
- **bundle size**: `_emptyDynamicSlot` helper は core に新規追加。minify 後 ~200 byte 想定

## Affected files

- `packages/core/src/jsx.ts`: `_$dynamicChild` 内の primitive / Signal branch 改修 + `_emptyDynamicSlot` 新設
- `packages/core/tests/hydrate.test.ts`: regression test 2 件追加 (LogicalExpression falsy + signal "" → 非空 swap)
- (transform 側の変更なし)

## Validation

- `vp test` (@vidro/core 254 / @vidro/router 81 件) all pass
- `apps/router` `vp dev` で /broken hydrate console error ゼロ (RootError fallback の `<!---->` placeholder で hydrate 成立)
- 他 route (/, /notes, /users, /does-not-exist) で regression ゼロ
- `feature-dev:code-reviewer` agent review で 1 件 critical 指摘 (effect 内 stale renderer capture) → fix 反映済

## Review Findings

`feature-dev:code-reviewer` agent (confidence 92):

> `_emptyDynamicSlot` の effect が引数 `r` (= hydrate 時に渡された HydrationRenderer) を closure で掴んでいる。hydrate 完了後 (= setRenderer で browserRenderer に戻る) に signal が `""` → 非空に遷移すると、effect re-run で stale な `r.createText` が cursor 消費を試みて "[hydrate] cursor exhausted" で throw する。

修正: effect body 内で `const active = getRenderer()` を毎回呼んで「実行時点の active renderer」を使うように変更。初回の `r.createComment("")` (synchronous な initial emit) は呼び出し時点で正しい renderer なのでそのまま。regression test (`tests/hydrate.test.ts`) でカバー済。
