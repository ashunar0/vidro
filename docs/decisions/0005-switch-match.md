# 0005 — `<Switch>` / `<Match>` primitive の実装方針

## Status

Accepted — 2026-04-23

## Context

`<Show>` は二分岐 (真偽) のみで、3 つ以上の分岐を書こうとすると `<Show>` のネスト
になり読めなくなる。多分岐を自然に書ける primitive が必要。

設計書 §3.2 の target syntax:

```tsx
<Switch fallback={<Default />}>
  <Match when={state.value === "loading"}>
    <Spinner />
  </Match>
  <Match when={state.value === "error"}>
    <Error />
  </Match>
  <Match when={state.value === "ok"}>
    <Content />
  </Match>
</Switch>
```

論点は 4 つ:

1. **`<Match>` の戻り値**: 実 DOM Node か、descriptor object か
2. **複数 true 時の挙動**: 全部 render か、最初の 1 つだけか
3. **fallback**: あり / なし
4. **children 評価タイミング**: invoke-once (Show 踏襲) か、遅延評価か

## Options

### 論点 1: `<Match>` の戻り値

**(A) descriptor object を返す (Solid 流)**

- Match は `{ [MATCH_SYMBOL]: true, when, child }` を返すだけ、DOM は作らない
- Switch が children 配列を走査して descriptor を取り出し、match したものを mount
- 型上は `Node` にキャスト (JSX.Element = Node を満たすため)

**(B) Match が実 DOM を作る**

- Match 自身が Show のような anchor + effect を持つ
- Switch が「どの Match を有効化するか」を調整する仕組みが必要
- Switch → Match 間で protocol が要る、複雑

### 論点 2: 複数 true 時

**(A) 最初に true の 1 つだけ (早い者勝ち、Solid 踏襲)**
**(B) 全 Match を render**

### 論点 3: fallback

**(A) `<Switch fallback>` prop で受ける**
**(B) fallback なし (全 false なら何も表示しない)**

### 論点 4: children 評価タイミング

**(A) 全 Match の children が最初に 1 回評価される (Show と同じ invoke-once)**
**(B) 遅延評価 (children getter 化、B-4)**

## Decision

- 論点 1: **(A) descriptor object を返す**
- 論点 2: **(A) 早い者勝ち**
- 論点 3: **(A) fallback prop あり**
- 論点 4: **(A) invoke-once (Show と同じ)**

## Rationale

### descriptor 方式を選んだ理由

- Match が実 DOM を作ると、Switch の判定より先に全 Match の effect が走って DOM が
  挿入されかねない。「表示する Match を Switch が選ぶ」という semantics を素直に表
  現するには、Match は marker であるべき
- Solid の実装もこれ。JSX runtime の都合 (Component は Node を返す) とは `as unknown
as Node` キャストで折り合う
- Switch が children を走査するだけで済み、Match ↔ Switch 間のプロトコルが要らない

### 早い者勝ち

- `<Switch>` の semantics として自然。HTML の `<select>` や if/else if チェーンと同じ
  読み味。全 match を render したいなら Switch を使う意味がない
- Solid 踏襲で学習コスト最小

### fallback prop

- 「全条件が false」は実用上よく発生する (loading / error / ok の他に idle を明示
  しない設計とか)。default UI を簡潔に書ける口があった方が良い
- `<Show fallback>` と対称なので、ユーザーから見て学習点が増えない

### invoke-once

- Show と同じ規約に揃えるのが「判断点を減らす」哲学 (設計書 §1 哲学 4) と整合
- 全 branch の DOM が事前構築されるコストは、現実的なアプリでは許容範囲
- B-4 化 (children getter 化) は Suspense と一緒にやる予定 (Phase 1 残タスク)。
  その際 Show / Switch / ErrorBoundary が一括で遅延評価に移行する想定

## Consequences

- Match を `<Switch>` の外で使っても何も表示されない (descriptor が Node 扱いで
  appendChild に渡ると、実 Node でないため型エラー or 無視)。docstring で警告する
  に留め、runtime で例外は出さない
- `readWhen` ロジックが `show.ts` と `switch.ts` で重複する。util 化は YAGNI で
  見送り (2 箇所程度なら重複の方が読みやすい)
- 全 Match の children が最初に評価される。重い初期化を含む branch がある場合、
  表示されなくても走る点に注意 (Solid も同じ制約)

## Revisit when

- JSX runtime の children getter 化 (B-4) を入れる時 — invoke-once を遅延評価に
  切り替える。Show / Switch / ErrorBoundary をまとめて移行
- `<Match>` の静的解析 (Switch 外で使った場合の lint warning) を入れたくなったら、
  linter rule を `@vidro/arch` (architecture pack) で提供する選択肢あり
