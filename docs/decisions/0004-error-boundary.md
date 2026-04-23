# 0004 — `<ErrorBoundary>` primitive の実装方針

## Status

Accepted — 2026-04-23

## Context

JSX ツリーの一部で発生した throw を受け止め、fallback UI に切り替える境界線が
欲しい。典型的ユースケース:

- ダッシュボードで 1 つの widget が壊れても他は動かす
- router の route segment 単位で失敗を閉じ込める
- 子 Effect / Computed の再実行が crash しても全画面クラッシュは避けたい

React / Solid の `<ErrorBoundary>` に対応する概念。ただし Vidro の invoke-once +
Owner tree モデルでは、React / Solid と同じ書き味にそのまま乗せられない制約がある
(children の評価タイミング、後述)。

論点は 5 つ:

1. **catch 対象**: 何を拾って、何を拾わないか
2. **onError の扱い**: optional / required
3. **fallback の形**: JSX ノード / 関数
4. **reset の意味**: 再評価する / Node 再利用のみ
5. **children の渡し方**: 普通の JSX / 関数で包む

## Options

### 論点 1: catch 対象

- **A.** 初期描画 (コンポーネント関数の throw)
- **B.** 子 Effect / Computed の再実行時の throw
- **C.** 子の onMount の throw
- **D.** Event handler (onClick 等) の throw

### 論点 2: onError

- **A. optional** (React / Solid と同じ)
- **B. required** (型で握りつぶし禁止)

### 論点 3: fallback の形

- **A. JSX ノード** (`<Show>` と同形): 情報なし
- **B. 関数** (`(err, reset) => Node`): err を受ける、reset も渡せる
- **C. 両対応**

### 論点 4: reset の意味

- **A. 非再評価**: error を null に戻すだけ、Node 再利用 (state は残る)
- **B. 再評価**: children を dispose → 新 Owner で作り直す (state 初期化)

### 論点 5: children の渡し方

- **A. 普通の JSX**: `<ErrorBoundary>...<Child />...</ErrorBoundary>`
- **B-1. 関数で包む**: `<ErrorBoundary>{() => <Child />}</ErrorBoundary>`
- **B-2. compile transform で自動包み**: 書き味は A のまま、transform 側で括る
- **B-4. JSX runtime を Solid 方式に進化**: children を getter 化して遅延評価

## Decision

- 論点 1 → **A + B + C** を catch、**D は対象外**
- 論点 2 → **B (required)**
- 論点 3 → **B (関数形)**
- 論点 4 → **B (再評価)**
- 論点 5 → **B-1 (関数で包む)** を MVP 採用、将来的に B-4 へ進化

公開 API:

```ts
<ErrorBoundary
  fallback={(err: unknown, reset: () => void) => Node}
  onError={(err: unknown) => void}
>
  {() => <Child />}
</ErrorBoundary>
```

## Rationale

### 論点 1: A + B + C、D 対象外

- A / B / C は **render パイプラインの中**で起きる throw。放置すると UI が壊れる →
  boundary の守備範囲
- D (event handler) は **既に表示済みの UI への操作**で起きる throw。画面は壊れない。
  Solid / React も D は対象外

### 論点 2: onError required

- React / Solid は optional だが、書き忘れると **fallback に吸われて dev が気付かない**
  (try/catch の握りつぶし問題と同構造)
- required にすると「通知導線を必ず書かせる」 = Go 的 "エラーは値、明示的に扱え" の
  精神を型で強制
- **AI-native 規約** との親和性: 書き忘れのリスクが AI 時代では相対的に下がる一方、
  「握りつぶしを許さない型」の価値はむしろ上がる
- 「何もしたくない」場合は `onError={() => {}}` と明示できる → 握りつぶしが
  コードに残る

### 論点 3: 関数形

- err を fallback UI に表示できない (A 案) と、dev / ユーザーが原因追跡できない
- reset の導線 (retry ボタン) が第 2 引数で自然に入る
- 両対応 (C 案) は柔軟だが、onError required と同じく **「選択肢を減らして規約化」** が
  AI-native 的。書き味統一を優先
- `fallback={() => <div>壊れた</div>}` で引数を使わない自由は残せるので、実害薄い

### 論点 4: 再評価

- 非再評価 (A 案) だと state がそのまま残り、同じ原因で再度 throw する可能性が高い →
  retry として機能しない
- 再評価 (B 案) は dispose → new Owner → 再 mount で state 初期化 → 一時的 glitch や
  再読み込みで復旧できる
- Solid も B 方式

### 論点 5: 関数で包む (B-1) → 将来 B-4

**背景**: Vidro の JSX runtime は `h(Parent, props, ...children)` 形式で、children は
h() 呼び出し時点で既に評価済みの Node になる。つまり

```tsx
<ErrorBoundary>
  <Child />
</ErrorBoundary>
// → h(ErrorBoundary, null, h(Child, null))
// JS の評価順で h(Child, null) が先に走る → ErrorBoundary の Owner scope が
// set される前に Child が評価される → 初期描画 throw を catch できない
```

**解決策の選択**:

- A (普通の JSX): 初期描画の throw を catch できない → 論点 1 の A が成立しない
- B-1 (関数で包む): 書き味に制約が付くが MVP として最小。`{() => <Child />}` を
  ErrorBoundary 内部で自分の Owner scope 内で呼べば全部 catch できる
- B-2 (compile transform 自動包み): B-1 の上位互換。実装コスト中
- B-4 (JSX runtime の children getter 化): Solid 方式。書き味は A のまま、runtime 全体
  改修。実装コスト大。`<Suspense>` 等、他の遅延評価 primitive を入れる時に一緒に
  やる方が効率的

**判断**: MVP は B-1 で最小の制約を受け入れる。B-1 の書き方は B-4 に移行しても
**そのまま動く (forward-compat)**。将来 Suspense を入れる段階で runtime を B-4 に
進化させると、ユーザーは `{() => <Child />}` も普通の JSX も両方書けるようになる。

## Consequences

### 実装

- `Owner` に `#errorHandler` + `setErrorHandler` + `handleError` + `runCatching` を追加。
  handleError は自身の handler → 親 → ... と辿り、root まで無ければ再 throw。
  bubble up の本体
- `Owner` の constructor に `{ attach?: boolean }` option を追加。Effect の childOwner は
  `attach: false` で parent 参照だけ保持 (dispose tree からは切り離すが error chain には
  載る)
- `Effect` は構築時の Owner を `#parentOwner` に保存し、childOwner を `{ attach: false }`
  で作成。`runCatching` で fn をラップし、throw を handler chain に流す
- `flushMountQueue` は各エントリを `{ fn, owner }` で持ち、flush 時に `owner.runCatching`
  で呼び出し → onMount 内の throw も boundary に届く
- `h()` の component 評価 (`type` が関数) も `runCatching` で囲む → 初期描画 throw の
  第一受け取り手を作る

### API 制約

- **`{() => <Child />}` の書き方が必須**。普通の JSX (`<Child />` 直書き) だと初期描画
  throw を catch できない。将来 B-4 化で解消予定
- event handler の throw は boundary では拾えない (Vidro は on\* props を
  `addEventListener` で直接 register するだけで wrap しない)。handler 内で try/catch
  するか、`window.onerror` に任せる

### 振る舞い

- fallback の中で throw した場合、fallback owner に handler を付けていないので自動的に
  親 owner chain (= 外側 boundary / root) に伝播 (bubble up)
- boundary が無い throw は mount 呼び出し元に再 throw される (根を突き抜ける)
- fallback は err が変わるたびに新しい Owner で再評価される (`fallbackOwner.dispose()` →
  `new Owner`)。fallback の internal state も毎回リセットされる
- onError prop 内で throw された場合は握りつぶさず上に伝播 (require を強制しておいて
  握りつぶすのは本末転倒なため)

## Revisit when

- **JSX runtime を Solid 方式 (B-4) に進化させる時**: `<Suspense>` primitive を入れる
  段階で children の getter 化を検討。B-4 に移行すると `{() => <Child />}` の書き味制約が
  消える (普通の JSX でも catch できるようになる)
- **event handler の throw も拾いたくなった時**: applyProp で on\* listener を
  `try/catch` でラップし、catch したら `getCurrentOwner()?.handleError(err)` に流す
  形に拡張可能。ただし DOM event の spec 上 `window.onerror` に任せる方が素直なので、
  強い要件が出てから検討
- **component への onError 型要求がキツすぎる場合**: optional に緩める余地。ただし
  この決断は設計書の AI-native 哲学と直結するので、変える時は philosophical に再議論
