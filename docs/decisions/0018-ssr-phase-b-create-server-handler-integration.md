# 0018 — SSR Phase B Step B-2c: createServerHandler integration + manifest 全 import + mount() の fresh render 化

## Status

Accepted — 2026-04-26

## Context

ADR 0017 (Step B-2b) で Router の server mode と `preloadRouteComponents`
helper、`renderToString(<Router ssr={...} />)` で sync に HTML 文字列を作る
道具は揃った。Step B-2c はその道具を `createServerHandler` の navigation
分岐に統合し、navigation response の `<div id="app">` に **実 markup を inject**
して返すこと。Phase A 時点では同 div は空のまま、bootstrap data だけ inject
していた。

統合の手前で 3 つの実装上の論点が立つ:

1. **`<div id="app">` への inject 方法**: 単純 `replace` か正規表現か
2. **renderToString 失敗時の挙動**: throw して 500 か、Phase A 動作に degrade か
3. **gatherRouteData / preloadRouteComponents / index.html fetch の並列度**

統合作業の中で 2 つの想定外も判明した:

4. **production の `route-manifest.ts` が tsx 系を空 stub にしていた**
   (`Promise.resolve({})`)。Phase A までは server で tsx を実行しない前提だった
   ため意図的な省略だが、Step B-2c では SSR で render するので **load 結果に
   `default` 関数が必須**。`leafMod.default is not a function` で renderToString
   が throw していた。
5. **client `mount(fn, target)` が SSR markup を吹き飛ばさず append していた**
   ため、初回表示で SSR markup と client markup の二重表示が発生 (Playwright
   snapshot で App が 2 回見える)。当初設計時は「mount は target を再構築する」
   という思い込みで、実装は `target.appendChild` だった。

## Options

### 論点 1: `<div id="app">` への inject 方法

- **1-a (単純 replace)**: `html.replace('<div id="app"></div>', ...)` で固定
  文字列置換
- **1-b (正規表現)**: `<div id="app"...>...</div>` を regex で match して
  中身だけ差し替え。属性 (class / data-\*) が付いていても耐える

### 論点 2: renderToString 失敗時

- **2-a (throw → 500)**: SSR バグに早く気づける、FCP は犠牲
- **2-b (Phase A degrade)**: try/catch で空 `<div id="app">` のまま返す。
  client が読んで render に逃がす。`console.error` で観測のみ残す

### 論点 3: 並列度

- **3-a (sequential)**: gather → preload → fetch index.html を直列
- **3-b (Promise.all)**: 3 つは互いに独立 (pathname のみ依存) なので 1 段階で
  並列実行

### 論点 4: production manifest の tsx 系

- **4-a (tsx 系を実 import に変更)**: `route-manifest.ts` 全 entry を `import * as`
  の実 module 参照に。server bundle のみで使われるので client には影響なし
- **4-b (server entry 側で別 manifest を作る)**: 別ファイル (例: `route-manifest.server.ts`)
  を生成し、tsx 系を含む完全版を server-entry が参照、client 側は触らない
- **4-c (server bundle build 時だけ jsxTransform で tsx を実 import に置換)**:
  vite plugin で transformIndex 時に分岐

### 論点 5: mount() の fresh render 化

- **5-a (router-demo 側で `root.replaceChildren()` 暫定 hack)**: app code に
  1 行加えるだけ。B-3 hydration が入ったら削除
- **5-b (`mount(fn, target)` 自体に `target.replaceChildren()` を入れる)**:
  core の挙動変更。`mount` の意味論を「fresh render — target の既存 children
  は捨てる」と確定させる
- **5-c (B-3 hydration まで何もしない)**: 重複表示を許容

## Decision

- 論点 1 → **1-b (正規表現)**
- 論点 2 → **2-b (Phase A degrade)**
- 論点 3 → **3-b (Promise.all)**
- 論点 4 → **4-a (manifest 全 entry を実 import に変更)**
- 論点 5 → **5-b (`mount` に `target.replaceChildren()` を入れる)**

## Rationale

**1-b**: 単純 replace は今の `<div id="app"></div>` でも動くが、将来 attribute
(`class="..."` / `data-test=...`) が付いた瞬間に黙って効かなくなる。同じ regex
で開きタグだけ保持して中身を差し替える形なら、template の小変更で壊れない。
コスト差は 5 行程度。

**2-b**: toy runtime の最優先は「壊れたら client に逃がす = 表示は出る」。
SSR 経路でしか起きないバグを 500 で表に出すのは UX 損失が大きい。`console.error`
が出れば dev 中に気付けるし、prod でも observability に拾われる。代わりに
将来 Phase B が「default」になって client fallback が無くなったときに 2-a に
戻す可能性は残す (Revisit 条件)。

**3-b**: 3 つは pathname のみに依存し、相互参照しない。`Promise.all` で
一段階で並列化すれば Worker round-trip が削れる。コードも `await Promise.all([])`
の 4 行で済むので導入コスト ≒ 0。

**4-a**: 候補 4-b / 4-c は **「manifest を 1 種類しか持たない」**という ADR 0014
の単純さを壊す。server bundle に tsx が混ざることで bundle size は増えるが
(53kB → +α)、SSR の前提条件なので不可避。client bundle は別 manifest
(`import.meta.glob`) を使うので影響なし。`@vidro/plugin` の生成ロジックは
むしろ簡素化される (kind 分岐が消える)。

**5-b**: `mount(fn, target)` の意味論は「target に新しい tree を生やす」=
fresh render。target の既存 children を残しておく必要があるユースケースが
存在しない (もしあれば fragment を作って append する別 API になる)。core で
1 行 (`target.replaceChildren()`) を追加するだけで意味論が明確になり、SSR /
non-SSR どちらでも一貫して動く。Step B-3 で `hydrate(fn, target)` が入ると、
こちらは「target を保ったまま walk + effect attach」という別 API として
共存する。**`mount` ↔ `hydrate` の対比** が綺麗に立つ。

## Consequences

- **server bundle が肥大化**: tsx 系 component と `@vidro/router` / `@vidro/core`
  全部 + jsx-runtime が server bundle (`dist-server/index.mjs`) に含まれる。
  router-demo 計測値: 37.8kB → 53.7kB (gzip 11.7 → 15.3kB)。Workers 制限
  (1MB) に対して余裕はあるが、scale すると気になる
- **manifest の tsx を server bundle で評価するため、tsx 内で `window` /
  `document` を直叩きしているコードは throw する**。jsx runtime は universal
  renderer 経由で抽象化済みだが、user component が直叩きしているとここで
  はじめて落ちる。Phase B の意味論として、user 側にも「server boundary」を
  意識させる必要がある (Step B-3 以降の課題、`.client.ts` 拡張子規約や lint
  rule で拾う)
- **mount() が必ず target を空にする**: 既存挙動に依存している app があれば
  break するが、router-demo / 既存 test では問題なし (mount 前に target を
  使っているケースが無い)。意味論を確立する好機
- **Phase A の bootstrap data script は冗長になった**が、Step B-3 hydration
  の props 復元源として温存。serialize size のオーバーヘッドはあるが、
  Step B-3 を完成させた時点で意味が立つ
- **renderToString failure の degrade は console.error しか残らない**ので、
  prod observability 側で Worker logs を拾う運用が必要

## Revisit when

- Step B-3 (hydration) が入ったとき:
  - `hydrate(fn, target)` を `mount` の隣に追加。`mount` は「既存 children
    を消して fresh render」、`hydrate` は「既存 children を保ったまま effect
    attach」 — 対比が API として表に立つ
  - bootstrap data script は hydration の props 復元源として正式に役割が確定
  - `apps/router-demo/src/main.tsx` は `mount` → `hydrate` に切替
  - renderToString failure 時の degrade は **client が SSR 失敗を察知できる
    flag** (例: `__vidro_data` に `ssrFailed: true`) を入れて hydrate を skip /
    full mount に fallback する経路に変える検討
- Step B-3 後に SSR が default になったら、論点 2 を 2-a (throw → 500) に
  ひっくり返すかも検討。SSR 失敗が「壊れた状態でも表示は出る」より「気付く
  べき bug」になるため
- server bundle size が問題になったら:
  - manifest を pathname → import の **lazy 化**。`server-entry.ts` 内で
    `match` した leaf だけ `import()` して await。Worker の cold start
    トレードオフを測ってから (lazy にすると初回が遅い)
  - もしくは Cloudflare Workers の `import()` deferred bundle 機能を活用
- `.client.ts` 拡張子規約 / lint rule (component が `window` 直叩きしていないか)
  を導入したいタイミング。RSC-like 移行 (memory `project_rsc_like_rewrites`) と
  まとめて再検討

## 関連 ADR

- 0014: prod 側 server boundary (manifest 生成、server entry)
- 0015: SSR Phase A (bootstrap data inject)
- 0016: Phase B Step B-1 (universal renderer)
- 0017: Phase B Step B-2b (Router server mode + preloadRouteComponents)
- 次: Step B-3 (hydration) — `mount` ↔ `hydrate` API 分割
