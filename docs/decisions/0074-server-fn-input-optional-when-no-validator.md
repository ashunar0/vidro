# 0074 — serverFn の input arg を validator なし時 optional に

## Status

**Accepted** — 2026-05-10 (66th session、dogfood 第 9 周目で着地確定)

経緯:

- 2026-05-10 (66th): F5 finding (dogfood 第 8 周目) を起点に Proposed 起票 + 案 B 実装 + dogfood smoke + code review、Accepted に昇格

依存: ADR 0073 (serverFn object slot signature)
関連: ADR 0066 (async server component native), `feedback_dx_first_design`, `feedback_ai_first_api_design`

## Context

ADR 0073 で確立した serverFn の public form は:

```ts
export type ServerFnPublic<Params, Data, R> = (input: ServerFnInput<Params, Data>) => Promise<R>;

export type ServerFnInput<Params, Data> = {
  readonly params?: Params;
  readonly data?: Data;
};
```

`input` 引数自体が **required**、中の `params` / `data` は両方 optional という構造。

### dogfood 第 8 周目 (2026-05-10) の F5

read 系 serverFn (= `listPosts` 等、validator なし / params なし / data なし) を呼ぶ時:

```ts
// .server.tsx 内
const posts = await listPosts({}); // ← {} が冗長、user の DX 痛い
```

`listPosts()` (no arg) と書きたいが、TS error。一方 runtime は client stub が「引数省略 → 内部 `{}` 扱い」を既にしている (= `packages/router/src/client.ts:72` のコメント) ので、**型だけが required を強制する** ねじれ状態。

server-side 直 invoke (= SSR で `await listPosts({})` する経路、ADR 0066 の async server component) でも同様、internalForm が `input.params` / `input.data` を直触りするので、引数省略すると runtime も crash する。

### 業界比較

- TanStack Start: `await fn({ data })` 必須 (= validator 経由が default、input 省略 case が少ない)
- tRPC: `await fn()` 許容 (= input schema を `.input()` で declarative に宣言、なければ no-arg)
- Hono RPC: `await client.posts.$get()` で query なし fn は no-arg

Vidro は ADR 0073 で object slot 採用、validator なしの fn は input slot 全て unused → tRPC 系の「input schema 無ければ no-arg」が DX 的に近い。

## Options

### 案 A: input 全体を一律 optional 化

```ts
export type ServerFnPublic<P, D, R> = (input?: ServerFnInput<P, D>) => Promise<R>;
```

- pros: type 簡潔、実装 1 行修正
- cons: validator あり (= `updatePost` 等) でも `await updatePost()` が型 OK → handler が必要な params/data 渡し忘れを **IDE で守れない** (runtime は 422 で弾くので silent fail にはならない but loose)

### 案 B: conditional type で「validator 両方なし → input optional」(= 採用)

```ts
type IsUnknown<T> = unknown extends T ? true : false;

export type ServerFnPublic<Params, Data, R> =
  IsUnknown<Params> extends true
    ? IsUnknown<Data> extends true
      ? (input?: ServerFnInput<Params, Data>) => Promise<R>
      : (input: ServerFnInput<Params, Data>) => Promise<R>
    : (input: ServerFnInput<Params, Data>) => Promise<R>;
```

判定ロジック: `unknown extends T` は `T` が `unknown` (or `any`) の時のみ `true`。validator slot で typed されていれば Params / Data は specific 型に倒れ、`unknown extends {slug:string}` は `false` になる。

case 別挙動:

| validator             | Params  | Data    | input arg | 例                       |
| --------------------- | ------- | ------- | --------- | ------------------------ |
| なし (= 両方 unknown) | unknown | unknown | optional  | `listPosts()` ✓          |
| params のみ           | typed   | unknown | required  | `getPost({params:...})`  |
| data のみ             | unknown | typed   | required  | `createPost({data:...})` |
| 両方                  | typed   | typed   | required  | `updatePost({...})`      |

- pros: validator あり fn は input required を維持 (= 安全性)、validator なし fn だけ no-arg 許容 (= DX)
- cons: type が conditional で複雑、`IsUnknown` の意味を読み手が理解する必要あり (コメントで補助)

### 案 C: read/write で別 primitive (`query()` / `mutation()` 分け)

TanStack Query like、HTTP method も分ける (= GET/POST)。

- pros: read endpoint が GET で expose、cache 経路と統合しやすい
- cons: overkill、3-tier の `+pack` 領域、ADR 0073 の object slot との二重 API、本論点の DX 改善には過剰

## Decision

**案 B を採用** — validator なし時のみ input optional、それ以外は required 維持。

`packages/router/src/server-fn.ts` の `ServerFnPublic` を conditional type 化、合わせて `internalForm` の冒頭で `input ??= {}` 防御を追加 (= server-side 直 invoke で `await listPosts()` を許容するため)。

## Rationale

- **DX-first** (memory `feedback_dx_first_design`): user が書くコードの見た目を起点、`{}` 冗長を type level で吸収
- **AI-first** (memory `feedback_ai_first_api_design`): no-arg fn は AI も自然に書ける、`{}` を覚える規約は減らす方が良い
- **段階的 strictness**: validator あり fn は input required で守る (= 案 A の loose 化を回避)、validator なしは元々 type-level constraint がないので optional 化しても何も失わない
- **runtime invariant**: client stub は既に no-arg 許容、本 ADR で型と runtime を一致させるだけ (= 振る舞い変更なし、TS API の縛りを緩めるだけ)
- **後方互換**: `await listPosts({})` は引き続き型 OK (= optional の widening として残る)

## Consequences

### 影響範囲

- `packages/router/src/server-fn.ts`:
  - `ServerFnPublic` を conditional type 化、`IsUnknown` helper 追加
  - `internalForm` の冒頭で `input ??= {}` 追加 (= server-side 直 invoke 経路の crash 防止)
- `packages/router/src/client.ts`: 既に no-arg 許容、変更なし
- 既存の `await fn({...})` 形式呼出: 全て型 OK のまま (= optional widening は backward compatible)

### type test 追加

`packages/router/test/server-fn-types.test-d.ts` (or 既存 type test に追加) で 4 case 確認:

```ts
// 1. no-validator: no-arg OK
const a = serverFn({ handler: async () => 1 });
expectAssignable<() => Promise<number>>(a);  // input なしで呼べる
a();           // ✓
a({});         // ✓ widening OK

// 2. params のみ
const b = serverFn({ validator: { params: schemaP }, handler: async ({params}) => 1 });
expectError(b());                       // ✗ input required
b({ params: { slug: "x" } });           // ✓

// 3. data のみ
const c = serverFn({ validator: { data: schemaD }, handler: async ({data}) => 1 });
expectError(c());                       // ✗ input required
c({ data: { title: "x", body: "y" } }); // ✓

// 4. 両方
const d = serverFn({ validator: { params: sP, data: sD }, handler: ... });
expectError(d());                       // ✗
d({ params: { slug: "x" }, data: {...} });  // ✓
```

### 知っておくこと

- `IsUnknown<any>` は `true` になる (= any も unknown 扱い)。実害なし、`any` を validator から流すことはない
- `IsUnknown<undefined>` は `false`。user が明示的に `serverFn<undefined, undefined>(...)` と書く edge case は input required になる、想定外なので無視

### `ServerFnInternal` (= `.run`) は input required のまま維持

public form だけ optional 化、`.run` の型は変えない。判断理由:

- `.run` は **dispatchServerFn / unit test 専用** の internal form。dispatchServerFn は常に `{ params, data }` を構築して渡す (= L659 で `mergedParams` + `bodyInput.data` を必ず object 化)、undefined が来る経路は構造的にない
- unit test で no-arg `.run` を呼ぶ動機は薄い (= 既存 test も全て `.run({}, c)` 形式、`{}` 1 文字省略の DX 改善は不要)
- runtime impl (`internalForm`) は `input ??= {}` 防御で undefined も crash しないので、後で `.run` を optional 化したくなっても破壊的変更にならない (= 型だけ広げれば済む)

`.run` 経路で no-arg を許容したくなったら本 ADR を update して `ServerFnInternal` の input も `ServerFnInput<P,D> | undefined` に変える。

### type test の構造選択

`packages/router/tests/server-fn.test.ts` 末尾の `describe("ADR 0074: ...")` block に runtime test と type test を混在させた。`.test-d.ts` 分離は採用しなかった (= 4 case の coverage は混在でも見通し良い、現状の規模で YAGNI)。

注意点 (= 流用時の落とし穴):

- `// @ts-expect-error` directive は **次行の TS error の存在を要求** する。directive が機能しなくなると "unused @ts-expect-error" として TS error 化、type regression を検知できる (= 設計として正しい)
- runtime は `// @ts-expect-error` で suppress されない、型違反でも実行は走る。validator あり fn を no-arg で呼ぶと 422 throw → try/catch で `err instanceof Response && err.status === 422` のみ silence、それ以外 (例: middleware が 403 返した場合) は rethrow して test を fail させる
- 流用する時は **silence する条件を必要最小に保つ** (= 422 のみ、403/500 等は rethrow)。広げると意図しない例外を握りつぶす

将来 type test の規模が増えたら `vitest` の `expectTypeOf` / `assertType` か `.test-d.ts` 分離を検討。

## Revisit when

- 案 C (`query()` / `mutation()` 分け) を導入する判断が立った時 (= cache primitive と統合する文脈、3-tier の `+pack` 検討時)
- TS 型 inference の挙動が変わって `IsUnknown` 判定が壊れた時 (= TS major upgrade 時に type test で検知)
- validator slot が増えた時 (= `query` / `form` slot 追加、ADR 0073 の論点 5)、conditional の判定 slot を拡張
