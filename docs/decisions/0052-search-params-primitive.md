# 0052 — `searchParams()` primitive: URL search 部分を client URL state として扱う

## Status

**Accepted** — 2026-05-02 (43rd session)

依存: ADR 0047 (store primitive) / ADR 0048 (props snapshot 規則) / ADR 0049 (`loaderData()`) / ADR 0051 (derive 楽観更新)

## Context

### 痛み A の起点

note 05 (`docs/notes/05-position-vs-marko-solid.md`) で整理した re-read mechanism の 2 軸のうち、**URL に出すべき state** (= filter / search / page / sort) を扱う primitive が空白だった。

具体的に困るシナリオ:

- `/notes?q=Vidro` で開いたら filter 適用済で表示してほしい (= shareable URL)
- filter 入力を変えたら URL も変わってほしい (= back button で「前の filter」に戻れる、SEO / 共有)
- ブラウザ back/forward (= popstate) で filter state も追従してほしい
- 現状: `loaderData()` (= server canonical store) と `signal()` (= page-local state) の **狭間** が空白

### Vidro identity からの制約

memory `project_design_north_star` を再確認:

- 個人 / hobby / cf scale (= 「作品」/「アート」)
- **「サーバーは初期状態を作って HTML を返す装置、その後の加工は client」** という哲学を取る
- 巨大データ (= 1M 件 pagination 等) は target 外、必要なら `@vidro/query` (将来 pack) で扱う

→ note 05 が当初想定した **「searchParam 変更 → loader 自動再実行」** は Inertia / Hotwire 流であり、上の哲学と齟齬する。loader 責務は「初期状態作成」に絞り、searchParam は **純粋な client URL state primitive** として独立させるのが識別性高い。

### 現状の `LoaderArgs<R>` / `ActionArgs<R>`

```ts
export type LoaderArgs<R extends keyof Routes = keyof Routes> = {
  params: Routes[R]["params"];
};
export type ActionArgs<R extends keyof Routes = keyof Routes> = {
  request: Request;
  params: Routes[R]["params"];
};
```

loader は URL 由来情報を **何も受け取れない**。本 ADR では loader 経路の拡張は **しない** (= searchParam は loader と独立)。

## Options

### A: searchParam → loader 自動再実行 (= note 05 当初想定、Inertia / Hotwire 流)

URL 変化 → router 検知 → loader 再 fire → 新 data → page re-render。

- Pros: 「URL = server state」mental model、pagination of 大データ自然対応
- Cons: filter-as-you-type で毎打鍵 server roundtrip (debounce 必須)、searchParam が暗黙 server trigger を持つ複雑さ、memory `project_design_north_star` の「server = 初期状態」哲学違反

### B: searchParam = 純粋な client URL state、loader は別軸 (= 採用候補)

URL ↔ signal 双方向 sync のみ。loader 再 fire は **action 完了 / explicit `revalidate()` / pathname 変更** の 3 経路に限定。

- Pros: 哲学整合、filter-as-you-type が client 完結 (= 瞬時)、primitive 責務が 1 つに絞られる
- Cons: 巨大データ pagination で fresh data 欲しい時 `revalidate()` boilerplate、ただし target scope 外として受容

### C: 両流派サポート

option `revalidate: true` で auto trigger、default は client only。

- Cons: 設定 surface 増、流派分裂で legibility test 弱まる、Vidro identity 立たない。**却下**。

## Decision

**B** を採用。

| 観点                                                    | B                                                                                   |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| memory `project_design_north_star` (server = 初期状態)  | ◎ 整合                                                                              |
| memory `project_html_first_wire`                        | ◎ HTML transition は `<Link>` / `navigate()` が担う、searchParam は ephemeral state |
| memory `project_legibility_test`                        | ◎ 「URL の search 部分を reactive store として扱う」と訳せる                        |
| memory `feedback_dx_first_design`                       | ◎ filter typing が瞬時、user code に boilerplate なし                               |
| memory `project_cache_as_fw_concern` (薄い core + pack) | ◎ core は薄いまま、巨大データは `@vidro/query` 案件                                 |
| 設計書「2-layer product structure」                     | ◎                                                                                   |
| 実装コスト                                              | 軽 (= URL ↔ store sync + popstate listen のみ)                                      |

### API shape (= 確定)

```ts
// @vidro/router

/**
 * 現在の URL の search 部分を reactive store として返す。
 *
 * - default: 全 key が `Signal<string | undefined>` として lazy access (typo 検出なし)
 * - generic 指定: 型 narrow を効かせる (= sort enum / status union 等)
 * - write (`sp.q.value = "..."`): URL を `history.replaceState` で更新 (= ephemeral state)
 * - delete (`sp.q.value = undefined`): URL から該当 param を完全削除
 * - empty (`sp.q.value = ""`): URL に `q=` (empty value) として残す
 * - popstate (戻る/進む): store field を自動更新
 */
export function searchParams(): Store<Record<string, string | undefined>>;
export function searchParams<T extends Record<string, string | undefined>>(): Store<T>;

/**
 * 現 route の loader を再 fire。Path Y では search params 変更で loader 再 fire しないため、
 * pagination 等で fresh data 欲しい時に explicit に呼ぶ。
 */
export function revalidate(): Promise<void>;
```

### 使い方 (= dogfood target)

```tsx
import { computed } from "@vidro/core";
import { searchParams, loaderData } from "@vidro/router";
import type { loader } from "./server";

export default function NotesPage() {
  const data = loaderData<typeof loader>();
  const sp = searchParams();

  const filtered = computed(() =>
    data.notes.filter((n) =>
      n.title.value.toLowerCase().includes((sp.q.value ?? "").toLowerCase()),
    ),
  );

  return (
    <div>
      <input
        value={sp.q.value ?? ""}
        onInput={(e) => {
          sp.q.value = (e.currentTarget as HTMLInputElement).value || undefined;
          // value === "" なら undefined に倒すと URL から消える (= 好みで)
        }}
      />
      <For each={filtered.value}>{(n) => <li>{n.title.value}</li>}</For>
    </div>
  );
}
```

narrow したい場面 (例: SaaS dashboard sort カラム choice):

```tsx
const sp = searchParams<{ sort?: "createdAt" | "id"; order?: "asc" | "desc" }>();
sp.sort.value; // "createdAt" | "id" | undefined
sp.order.value; // "asc" | "desc" | undefined
```

pagination で fresh data 欲しい場面:

```tsx
const sp = searchParams();

effect(() => {
  sp.page.value; // depend
  revalidate(); // 現 route の loader を再 fire
});
```

### 全論点の決定一覧

| #   | 論点                    | 採用                                                                  | 理由                                                                                    |
| --- | ----------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 1   | API shape               | **store 全体** (= 案 C)                                               | loaderData() / store と shape 整合、destructure で signal 取れる                        |
| 2   | 型 declare              | **default = 全 string optional + generic で narrow** (= P + Q hybrid) | URL は元々 string、declare 不要が DX 最大、narrow 必要なら escape hatch                 |
| 3   | 書き込み時 history mode | **replaceState 固定**                                                 | searchParam は ephemeral state、pushState は `<Link>` / `navigate()` の navigation 責務 |
| 4   | popstate (戻る/進む)    | **router が listen、store auto-update**                               | URL ↔ signal sync 成立に必須、自明                                                      |
| 5   | SSR 時                  | **`request.url` から URLSearchParams、store 初期化**                  | server / client で同じ API、hydrate cleanly                                             |
| 6   | param 削除              | **`undefined` で完全削除、`""` で空文字値として残す**                 | `URLSearchParams.delete()` vs `set("", "")` 素直な mapping                              |
| 7   | `revalidate()` API      | **`@vidro/router` から export、no-arg で現 route**                    | Path Y で必要、最小 API                                                                 |

## Rationale

### 1. server = 初期状態哲学の貫徹

memory `project_design_north_star` に追記した「Vidro = 作品 / アート的な取り組み」stance を採用すると、**「思想を技術的に形にできるか」** が design 軸になる。Inertia / Hotwire 流の「URL 変化 → server roundtrip」は scale-friendly だが、Vidro target (個人 / cf scale) では overkill であり、かつ哲学齟齬する。

Path Y を取ることで loader 責務が「初期状態作成」1 つに絞られ、`loaderData()` / `submission()` / `searchParams()` の責務分離が clean になる:

- `loaderData()` = server から来た canonical data (= mutate は action 経由のみ)
- `submission()` / `submissions()` = action lifecycle (= mutation の進行状態)
- `searchParams()` = URL search 部分 (= ephemeral client state、URL ↔ signal sync)

3 primitive がそれぞれ **時間軸境界** (note 05) の 1 役を担う構造。

### 2. store-like access pattern の選択 (= 案 C)

Remix `useSearchParams` / SolidStart `useSearchParams` は `[get, set]` tuple で React mental model 寄り。Vidro は store primitive (ADR 0047) と shape 統一することで:

- `loaderData()` と同じ `.value` 規約 (= legibility test 強い)
- destructure すれば signal が取れる (= `const q = sp.q;` で `<Foo q={q} />` 渡せる)
- 案 A (= 個別 `searchParam("q")` 呼び出し) を superset として包含

memory `project_legibility_test` の「読んで日本語に訳せる」観点で、`sp.q.value` は「sp の q の現在値」と素直に訳せる。

### 3. default 全 string optional の合理性 (= 案 P)

URL の search 部分は **元々 string しか持てない**。そこに型 narrow を強制すると:

- declare boilerplate (= 各 page で SearchParams type を書く)
- layer 違反 (= server.ts に書くと client primitive が server file に依存、Path Y と矛盾)
- typo 検出は個人 scale では low ROI

→ **declare 不要 default** が DX 最大。narrow したい時 (= sort enum 等) は generic で escape。これは memory `feedback_dx_first_design` の「user code 起点の API」と整合。

### 4. write = replaceState 固定の哲学

filter input typing で各 character ごとに pushState すると history が爆発する。逆に pagination で replaceState だと「戻る」で前 page に戻れない。

→ **責務分離**で解決:

- searchParams write = **ephemeral state** (= filter input 反映)、history 汚さない
- navigation (pushState) = **`<Link>`** / **`navigate()`** で明示

memory `project_html_first_wire` が「URL transition は HTML-first」と置いており、`<Link>` が navigation の正典。searchParams が pushState option を持つと責務が膨張する。

pagination は `<Link href="?page=2">` か `navigate("?page=2")` で書く方が user 意図が明示される (= legibility test 強い)。

### 5. popstate / SSR / 削除の自明性

popstate (= 戻る/進む) は URL ↔ signal sync の対称性で **必ず必要**。router 側で `window.popstate` を listen して store field を mutate するのみ。user 側コード変化なし。

SSR 時は `request.url` から URLSearchParams を取って store 初期値に流すだけ。client hydrate も `window.location.search` から同じ初期化 → 値一致で cleanly hydrate。

`undefined` 代入で URL から完全削除、`""` 代入で空文字値として残す挙動は `URLSearchParams.delete()` / `.set("", "")` の素直な mapping で legibility 高い。

### 6. `revalidate()` の最小性

Path Y で loader 再 fire 経路は 3 つに限定:

1. action 完了後 (= ADR 0037 既存、自動)
2. **explicit `revalidate()`** (= 本 ADR で新規追加)
3. pathname 変更 (= `<Link>` / `navigate()` 経由、既存)

`revalidate()` は no-arg で現 route のみ対応。他 route 指定や条件付き revalidate は YAGNI、痛みベースで sugar 追加 (= memory `project_app_scaffolding_strategy` 通り)。

## Consequences

### 公開 API (= `@vidro/router` 追加)

```ts
export function searchParams(): Store<Record<string, string | undefined>>;
export function searchParams<T extends Record<string, string | undefined>>(): Store<T>;
export function revalidate(): Promise<void>;
```

### lifecycle 規定

- **生成**: 同 page 内で `searchParams()` を複数回呼んでも **同じ instance** を返す (= ADR 0049 loaderData() と同 shared instance pattern)
- **初期化**: server SSR は `request.url`、client は `window.location.search` から URLSearchParams 取得して store 初期化
- **write (`sp.q.value = "..."`)**: store field を update + `history.replaceState({}, "", newUrl)` で URL 更新
- **delete (`sp.q.value = undefined`)**: store field の signal value を undefined にする + URL から該当 param を `URLSearchParams.delete()`
- **popstate**: router が `window.popstate` listener で store field を URL の最新値に書き戻し
- **navigation (`<Link>` / `navigate()` 経由 pathname 変更)**: 前 page の searchParams instance は dispose、新 page の URL から新 instance 初期化

### 実装ステップ

1. `packages/router/src/search-params.ts` を新規作成 (factory + URL ↔ store sync)
2. `packages/router/src/index.ts` に `searchParams` / `revalidate` を export 追加
3. `packages/router/src/router.tsx` で `window.popstate` listener を登録 (client mode)、store の field を URL から書き戻し
4. SSR 経路 (`packages/router/src/server.ts`) で `request.url` から URLSearchParams を取って searchParams instance の初期化に流す
5. `packages/router/src/loader-data.ts` (existing) に `revalidate()` を追加 or `packages/router/src/navigation.ts` に置く (= 既存 navigation 機構との隣接で)
6. `apps/router/src/routes/notes/index.tsx` を migration:
   - filter input の `value` / `onInput` を signal から searchParams に変更
   - `?q=Vidro` 直打ちで filter 適用済表示の確認
7. unit test:
   - `searchParams()` の field access が signal を返す
   - write で `history.replaceState` が呼ばれる
   - popstate で store が auto-update する
   - SSR と client で同じ初期値を返す
   - shared instance (同 page 内 multi-call で identity 一致)
8. memory 更新 (= `project_next_steps` に進捗反映)

### dogfood 検証手順 (= 43rd session 末で実機確認予定)

`apps/router` `vp dev` で:

1. `/notes?q=Vidro` 直打ち → filter "Vidro" 適用済で表示される (= server で initial state 構築)
2. filter input に文字を入力 → URL の `?q=` が同期更新 (replaceState、history 汚れない)
3. ブラウザ戻るボタンで前 URL に戻る → 該当 path の navigation。同 path 内の `q=` 履歴は積まれてないため戻らない (= 仕様)
4. `<Link href="?page=2">Next</Link>` で pushState 経由 navigation → 戻るボタンで `?page=1` に戻る、`sp.page.value` も追従
5. `sp.q.value = undefined` で URL から `q=` が完全削除されることの確認

### scope 外 (= 別 ADR で扱う)

- **searchParam 変更 → loader auto re-fire**: `@vidro/query` (将来 pack) で対応。core は独立を維持
- **debounce / throttle**: filter input typing で URL 更新 rate 制限。痛みベースで sugar 追加検討
- **複数 param 一括更新**: `sp.batch(() => { sp.q.value = "x"; sp.page.value = "1"; })` のような batch API。痛みベースで追加
- **enum union 以上の型 (number / boolean coerce)**: `searchParams<{page: number}>()` で number narrow → user 側で `Number(sp.page.value)` で coerce。framework 側 coerce は YAGNI

## Revisit when

- **filter input の URL 更新が高頻度すぎる痛み**定常化 → debounce sugar (= `searchParams({ debounce: 200 })` 等)
- **複数 param 同時更新 boilerplate**定常化 → batch API
- **巨大データ pagination で `revalidate()` 連発の boilerplate**定常化 → `@vidro/query` (= TanStack 流 pack) を別 ADR で
- **type narrow で number / boolean coerce が定常化** → coerce sugar (`searchParams<{page: number}>()` で自動 Number 変換)
- **server で searchParams を直接読みたい場面** (= SSR 時に loader が `q` を見て pre-filter したい等) が出た → `LoaderArgs.searchParams` を別 ADR で追加検討 (= Path X 部分復活、現状は scope 外)

## 関連

- ADR 0011 — `routeTypes()` codegen (= RouteMap 拡張は本 ADR では行わない、type generic で narrow する経路)
- ADR 0037 — action primitive R-min (= action 完了後 loader 自動 revalidate、本 ADR の `revalidate()` と並走)
- ADR 0047 — store primitive (= 戻り型 `Store<T>` の実体)
- ADR 0048 — props snapshot 規則 (= reactive は明示 primitive で declare、本 ADR も同流儀)
- ADR 0049 — `loaderData()` (= shared instance pattern の参照)
- ADR 0051 — derive 楽観更新 (= action 経路の到達点、本 ADR と責務分離)
- `docs/notes/05-position-vs-marko-solid.md` — Path Y 採用の素材 (= re-read 2 軸の整理)
- memory `project_design_north_star` — server = 初期状態哲学 / 作品 stance
- memory `project_html_first_wire` — `<Link>` が navigation の正典
- memory `project_cache_as_fw_concern` — 薄い core + 厚い query pack
- memory `project_legibility_test` — store access の訳しやすさ
- memory `feedback_dx_first_design` — declare 不要 default の根拠
- memory `project_type_vertical_propagation` — generic narrow の延長線上にある identity
