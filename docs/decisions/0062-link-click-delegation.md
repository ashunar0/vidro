# 0062 — Document-level click delegation for SPA navigation

## Status

**Accepted** — 2026-05-06 (55th session、ADR 0061 Phase 3 dogfood で発見した抜けに対する後追い ADR / user 合意取得 / 未着工)

依存: ADR 0061 (server-only page SPA navigation)、ADR 0060 (partial hydration impl)、ADR 0058 (.server.tsx semantics)
関連: ADR 0057 (FW design stance)、ADR 0017 (Router server mode)

## Context

### ADR 0061 Phase 3 dogfood で発見した抜け

ADR 0061 Phase 2 着地時点で:

- `<Link>` 自身の `onClick` で `e.preventDefault() + navigate(href)` を実装 (`packages/router/src/link.tsx:50-56`)
- effect 側で leaf が `.server.tsx` なら `/__partial` 経由 swap、それ以外なら client fold
- Phase 2 commit message では「partial swap 経路の検証 OK」と記載

しかし Phase 3 dogfood で `/posts/1` → 記事下部の prev/next `<Link>` クリックを実機検証したところ:

- expected: `/__partial?to=/posts/2&from=/posts/1` 経由 partial swap (= layout 据置)
- actual: `/__partial` には飛ばず、`GET /posts/2` の **full page reload** に倒れる (= layout 含めた flash)

### 原因 (= ADR 0060 と衝突)

ADR 0060 で `.server.tsx` は **client bundle 上で stub 化** される (= virtual module、`default` は空を返す)。よって:

- `posts/[id]/index.server.tsx` 内に書かれた `<Link>` 自体が **client で render されない**
- → `<Link>` の `onClick` handler が DOM に **attach されない**
- → SSR 済 `<a href="/posts/2">` は素の `<a>` のまま残り、click は browser default で full navigation

一方 `apps/router/src/routes/layout.tsx` (= 通常 `.tsx`) 内の nav `<Link>` は client bundle に乗って hydrate される → onClick attach される → preventDefault → partial 経路成立 (= Phase 2 commit で確認できていたのはこちらだけ)。

つまり Vidro 哲学的に:

> `<Link>` の click intercept を **component の render** に依存させると、`.server.tsx` (= bundle stub 化される component) 内の Link は intercept できない。これは ADR 0060 で「.server.tsx は client bundle に乗らない」と決めた以上、構造的に避けられない衝突。

### 関連: 同 issue は Link 以外も踏みうる

- `.server.tsx` 内に `<form action="...">` を直書きした場合 → submit handler の preventDefault も同様に attach されない (= browser default の form post に倒れる)
- 現状の Vidro action primitive は `useAction()` 経由 island で扱う前提なので顕在化していないが、構造としては同根

→ 本 ADR では Link 限定で扱う (= form は ADR 0051 island 経由が canonical)。Link は基本 component すぎて「leaf 内に書いても動かない」は Vidro 入門時の落とし穴になる。直す。

## Options

### A. document-level click delegation (= 採用案)

router boot 時に **`window.addEventListener('click', ...)` を 1 個だけ仕掛け**、`<a>` クリックを bubble phase で一括 intercept する (= form submit delegation の `window` 登録と表記を揃える)。

```ts
// packages/router/src/router.tsx (boot 時、client mode のみ)
window.addEventListener("click", (e) => {
  if (e.defaultPrevented) return;
  if (e.button !== 0) return;
  if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
  const a = (e.target as Element | null)?.closest?.("a[href]");
  if (!(a instanceof HTMLAnchorElement)) return;
  if (a.target && a.target !== "_self") return;
  if (a.hasAttribute("download")) return;
  if (a.origin !== window.location.origin) return;
  // 外部リンク、tel:, mailto:, javascript: 等は origin 一致の時点で除外済
  e.preventDefault();
  const href = a.pathname + a.search + a.hash;
  navigate(href);
});
```

`<Link>` の onClick handler は **削除**。`<Link>` は単に `<a>` を render する + `aria-current` を reactive 切替するだけの component に縮退する (= 同 origin の `<a>` を書けば click delegate 経由で SPA 遷移する設計)。

#### 採用理由

1. **leaf 内 / layout 内を区別せずに均一に動く** = `.server.tsx` の bundle stub 化と非衝突
2. **Solid Router / TanStack Router / Nuxt 等で確立された pattern** = legibility test (memory `project_legibility_test`) を passes、user は「`<a>` を書いたら SPA で動く」と読める
3. **生 `<a>` も SPA 化される** = 設計書「`<a>` 直書きでも遷移できる」素朴さ。`<Link>` は aria-current のための糖衣だけになる
4. **bundle 軽量化** = `<Link>` 1 個ごとの onClick closure が消える (=多数の Link がある page では非無視)

#### Trade-offs

- document level listener 1 個で全 click を捌くので **除外条件の漏れ = 全 click に影響**。修飾キー / target=\_blank / download / 異 origin / hash 内同 page 等を網羅する必要あり (= 採用案コードで列挙済)
- `e.preventDefault()` を後追いで仕掛ける都合、user 側 onClick で navigate を **抑止したい** ケースは `e.preventDefault()` を打ってもらう必要 → 上記 listener が `defaultPrevented` を見て早期 return する設計で吸収

### B. `.server.tsx` 内 Link を auto-island 化

`@vidro/plugin` の jsxTransform 段で `.server.tsx` 内の `<Link>` を検出して **island registry に登録**する compile-time transform。client bundle に Link 単体を island として残す。

#### 不採用理由

1. plugin 側の透視深度が深くなり Vidro 哲学 (透明性、AI-native 規約) に反する
2. **Link 以外の interactive component (form 等)** も同じ問題を踏むので、結局 generic な解 (= A) が必要
3. island ごとの shell 維持 (vi-X-N marker) で SSR markup が膨れる
4. user が `<MyCustomLink>` のような Link wrapper を書いた瞬間に transform が miss する (= 表面 syntax 依存)

### C. leaf 内 Link は full reload を受容

`.server.tsx` page 内の Link は full reload と諦め、ドキュメント化のみ。

#### 不採用理由

1. ADR 0061 で「server-only page でも layout 据置 SPA navigation」を達成すると decide した直後に部分撤回することになり、内部論理が破綻
2. user 視点で「layout 内 Link はぬるっと、leaf 内 Link は flash」という挙動分岐は非対称で legibility test 不合格
3. layout が太い app で実用上致命的 (= scroll / focus / island state が毎回吹き飛ぶ)

## Decision

**A 採用**。document level click delegation を `@vidro/router` の client boot 時に仕掛け、`<Link>` の onClick handler は削除する。

## Consequences

### Pros

1. **leaf 内 / layout 内 Link どちらでも均一に SPA navigation 成立** = ADR 0061 の本旨が完全動作
2. **生 `<a href="/posts/1">` も SPA 経路に乗る** = 「`<a>` を書けば動く」素朴さ、設計書 5 哲学の「Hono 的透明性」と整合
3. **`<Link>` は aria-current の糖衣だけに縮退** = 責務が単純化、user は `<Link>` / `<a>` 両方どちらを書いても SPA で動く前提を持てる
4. **Link 以外の interactive (form 等) との対応規律が明確化** = SPA 化対象は `<a>` のみ、interactive event は island 経由が canonical (= ADR 0051 と整合)

### Cons / Trade-offs

1. **document level listener 1 個に除外条件が集約** = 修飾キー / target / download / origin / hash 等の判定漏れがすべての click に伝播するリスク → 実装で明示列挙 + test 化で吸収
2. **後方互換**: `<Link>` の onClick が消えるので、user code が直接 `<Link onClick={...}>` で副作用を書く経路は無効化される。ただし `<Link>` の `onClick` prop は元から型に居ないので影響なし

### YAGNI (= 本 ADR では入れない)

- **scroll restoration on navigate** = 別途 ADR で扱う (popstate scroll memory 等は本 ADR の範囲外)
- **prefetch on hover / viewport** = future enhancement、`<Link>` を島化する流れと別軸
- **transition / view transitions API 統合** = browser API safety 前提で別 ADR
- **client side cache (= ADR `project_cache_as_fw_concern` 経由)** = 別 layer

## Implementation Plan

### Phase 1: delegate listener 追加 + `<Link>` onClick 削除

1. `packages/router/src/router.tsx` の client boot 経路 (`hydrateRouter` / 同等) で `document.addEventListener('click', linkClickDelegate)` を 1 度だけ登録
2. `linkClickDelegate` は採用案コードの除外条件を網羅 (`button !== 0` / 修飾キー / `target` / `download` / `origin` / `defaultPrevented`)
3. `packages/router/src/link.tsx` から `handleClick` を削除、`onClick` prop を h() に渡さなくする。aria-current の effect 経路は維持
4. listener cleanup: 現状 router boot は 1 度きりなので removeEventListener は YAGNI、ただし HMR で boot が再走する場合に備えて idempotent flag (= `__vidroLinkDelegateInstalled`) で重複登録を防ぐ

### Phase 2: dogfood 再開 (= ADR 0061 Phase 3 の積み残しを continue)

1. `/posts/1` ↔ `/posts/2/3` の prev/next Link click で partial swap が走ること実機確認 (= Phase 3-2)
2. layout が変わる navigation (`/posts/1` → `/users/1`) で layout 切替確認 (= Phase 3-3)
3. popstate (戻る/進む) (= Phase 3-4)
4. search params (= Phase 3-5)
5. error 経路 dogfood (= Phase 3-7)

### Phase 3: tests

1. `packages/router/tests/` に click delegate の unit test 追加
   - 修飾キー付き click は preventDefault されないこと
   - 異 origin / target=\_blank / download は preventDefault されないこと
   - 同 origin の `<a>` は preventDefault + navigate
   - `defaultPrevented` 済 event は早期 return
2. `<Link>` の hydrate test は aria-current 部分のみに縮退 (= onClick 経路 expect 削除)

### 工数見積

合計 **~150-250 行** (= 実装 + test + docs)、ADR 1 サイクル未満 (= 1 セッション)。Phase 3 dogfood は本 ADR Phase 2 と統合。

## Open Questions

実装着手時に decide する項目:

1. **server-side render 時の Link**: server mode でも `<Link>` を render するが、server では document が無いので click delegate も走らない。ここは「server render 時は SSR markup を吐くだけで click handler 不要」で素直に問題なし。確認のみ。
2. **listener 登録タイミング**: `hydrateRouter` 起動時 1 度きりで足りるか、route swap 経路 (= partial swap 後 / full swap 後) で再登録不要か → document level listener なので 1 度きりで十分のはずだが、初実装時に router boot fn の構造を見て確定する。
