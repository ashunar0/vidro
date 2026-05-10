// ADR 0073: serverFn signature を object slot form に改修。
//
// 旧 signature (= ADR 0070 + 0072) は positional args (= `(slug, input, c)`)、
// validator middleware が `next([parsed.data])` で args 全 override する設計。
// dogfood 第 4 周目で URL 動的 segment と validator 共存不可 (= F1) が顕在化、
// 62nd で object slot 採用。
//
// 設計判断 (ADR 0073):
//   - handler は `({ params, data, ctx })` の object 1 個のみ受ける、c は完全排除
//   - serverFn は config object 1 個渡し: `serverFn({ middleware, validator, handler })`
//   - middleware は `({ c, ctx, next })` の 3-slot 形、`next({ ctx })` で ctx
//     accumulation する経路 (= TanStack Start 流)
//   - validator は { params, data } slot 別 schema、middleware 列の中ではなく
//     serverFn config の `validator` key で declarative に書く
//   - public form (= client) は `(input: { params, data }) => Promise<R>`、
//     internal form (= dispatch / test) は `(input, c) => Promise<R>`、
//     `.run(input, c)` で internal form 露出 (ADR 0072 path 継承)
//
// 関連:
//   - ADR 0070 = server function pattern (positional 設計、本 ADR で全面 supersede)
//   - ADR 0072 = pure handler signature (`(input, c?)` 末尾 optional 設計、本 ADR で
//     object slot に置き換え)
//   - ADR 0071 = `@vidro/zod` validator middleware (本 ADR で削除、validator slot に統合)
//   - ADR 0066 = async server component native + getRequestEnv (ALS scope 互換維持)

import { getRequestEnv } from "./request-env-scope";

/**
 * Cloudflare Workers の execution context (= subset)。`waitUntil()` で response
 * 後の background task を登録できる。Workers 以外の runtime では undefined。
 */
export type ExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
};

/**
 * HTTP Context (= 入力情報 + 実行環境)。**middleware だけが扱う、handler からは
 * 完全に隠す** (ADR 0073 論点 3-i)。
 *
 * - `req` = HTTP request meta (= URL / headers / query)。body は wire decode 後に
 *   serverFn 内部で `{ params, data }` として decode 済、middleware が body を直接
 *   触る経路は廃止 (ADR 0073 で `c.var.body` 廃止、validator が data slot を直接 parse)
 * - `env` = Cloudflare bindings 等の実行環境。ALS scope と統合
 * - `executionCtx` = `waitUntil()` 等
 *
 * 旧 ADR 0070-0072 では `c.set` / `c.var` で middleware 間値受け渡しをしていたが、
 * ADR 0073 で **`ctx` slot に置き換え** (= 型付き、middleware の `next({ ctx })`
 * 経路で accumulation)。c.var は廃止、後方互換も取らない (= apps/blog 全 migration)。
 */
export type Context = {
  readonly req: {
    readonly url: string;
    readonly headers: Headers;
    /** URL query string を取得 (= `?foo=bar` の `foo`)。 */
    query(key: string): string | undefined;
  };
  /**
   * Cloudflare bindings (= D1 / KV / R2 等) や任意の user 側 env。
   * 既存 `getRequestEnv<T>()` (= ALS scope) と統合: serverFn が context 構築時に
   * ALS の現在 env を inject する。引数 env が明示されていればそちらを優先。
   */
  readonly env: unknown;
  /** Cloudflare execution context。Workers 以外の runtime では undefined。 */
  readonly executionCtx?: ExecutionContext;
};

/**
 * Middleware の `next()` に渡す delta object。`{ ctx }` で ctx slot を更新する。
 * `next()` 引数なし呼び出し = 前段 ctx をそのまま流す。
 *
 * generic `TOut` は middleware の Out 型。`MiddlewareArgs.next` の引数として
 * 出現することで、`Middleware<infer TOut, ...>` 経由の inference が成立する
 * (= phantom type の落とし穴を回避、MergeCtx の tuple recursion で accumulate 可能)。
 */
export type NextDelta<TOut extends Record<string, unknown> = Record<string, never>> = {
  /**
   * ctx slot に merge する値。前段 ctx と spread で合成 (後勝ち)、TS 型上も
   * intersection で accumulate される。
   */
  ctx?: TOut;
};

/**
 * Middleware の引数 (= 3-slot destructure)。
 *
 * - `c` = HTTP Context (= 入力情報、middleware が見る)
 * - `ctx` = 前段 middleware が accumulate した値 (= 自分が読む側)
 * - `next` = 次段に進む、optional で ctx delta を渡す。delta の `ctx` 型は TOut。
 */
export type MiddlewareArgs<
  TOut extends Record<string, unknown> = Record<string, never>,
  TIn extends Record<string, unknown> = Record<string, never>,
> = {
  readonly c: Context;
  readonly ctx: TIn;
  readonly next: (delta?: NextDelta<TOut>) => Promise<void>;
};

/**
 * Middleware 関数。`next()` を呼んで chain を進める、呼ばずに Response を return
 * すると早期 return (= auth fail / 422 等)。
 *
 * generic:
 *   - `TOut` = 自分が次段に inject する ctx の型 (= `next({ ctx: { user } })` の
 *     `{ user }` の型)、`defineMiddleware<TOut>(fn)` factory で表明する。
 *     `MiddlewareArgs.next` の引数 (= `NextDelta<TOut>`) に出現するので、
 *     `Middleware<infer HOut, ...>` で infer 可能 (= phantom type にしない設計)。
 *   - `TIn`  = 自分が前段から受け取る ctx の型 (= 前段までの accumulation)
 */
export type Middleware<
  TOut extends Record<string, unknown> = Record<string, never>,
  TIn extends Record<string, unknown> = Record<string, unknown>,
> = (args: MiddlewareArgs<TOut, TIn>) => Promise<void | Response> | void | Response;

/**
 * `defineMiddleware<TOut>(fn)` factory。middleware の Out 型を表明する。
 * generic を marker として埋め込み、middleware list の Out 型 accumulate に使う。
 *
 * @example
 * const authMw = defineMiddleware<{ user: User }>(async ({ c, next }) => {
 *   const token = c.req.headers.get("authorization");
 *   const user = await verifyToken(token);
 *   await next({ ctx: { user } });
 * });
 */
export function defineMiddleware<TOut extends Record<string, unknown>>(
  fn: Middleware<TOut, Record<string, unknown>>,
): Middleware<TOut, Record<string, unknown>> {
  return fn;
}

/**
 * Middleware list の Out 型を intersection で accumulate する型 utility。
 * 流派 1 (= object 1 個渡し) で middleware が array で渡されるので、tuple
 * recursion で Out 型を畳み込む。
 *
 *   MergeCtx<[Mw<{a}>, Mw<{b}>]> = { a } & { b }
 *   MergeCtx<[]>                  = {}
 */
export type MergeCtx<MWs extends readonly Middleware<Record<string, unknown>>[]> =
  MWs extends readonly []
    ? Record<string, never>
    : MWs extends readonly [
          Middleware<infer HOut, Record<string, unknown>>,
          ...infer Rest extends readonly Middleware<Record<string, unknown>>[],
        ]
      ? HOut & MergeCtx<Rest>
      : Record<string, never>;

/**
 * Handler の入力 object (= `{ params, data, ctx }`、ADR 0073 採用 form)。
 *
 * - `params` = URL 動的 segment (= `[slug]` 等)、validator.params で typed
 * - `data`   = body 入力、validator.data で typed
 * - `ctx`    = middleware accumulation
 */
export type HandlerInput<Params, Data, Ctx extends Record<string, unknown>> = {
  readonly params: Params;
  readonly data: Data;
  readonly ctx: Ctx;
};

/**
 * Handler 関数 (= ADR 0073、object 1 個受ける、c は受けない)。
 */
export type Handler<Params, Data, Ctx extends Record<string, unknown>, R> = (
  input: HandlerInput<Params, Data, Ctx>,
) => Promise<R> | R;

/**
 * Validator slot に渡せる schema-like object の duck typing interface。
 * zod の `ZodType` がそのまま満たす shape (= `safeParse(input): { success, data, error }`)、
 * `@vidro/router` は zod に直接依存しない (= ADR 0071 opt-in 哲学維持)。
 *
 * `error.issues[]` の shape も zod 互換、422 wire の `fields` flatten に使う。
 * user が zod 以外の validator (= valibot 等) を使いたい時、同 shape の wrapper を
 * 書けば差し替え可能。
 */
export type ValidatorSlot<T> = {
  safeParse(
    input: unknown,
  ):
    | { success: true; data: T }
    | { success: false; error: { issues: ReadonlyArray<ValidatorIssue> } };
};

/**
 * zod ZodIssue 互換 minimum shape (= path + message)。422 fields flatten で使う。
 *
 * `path` は `ReadonlyArray<PropertyKey>` (= `string | number | symbol` widening)
 * を受ける。zod 4.x の `ZodIssue.path` は `(string | number | symbol)[]` なので、
 * narrow を要求すると `ZodObject` 型が `ValidatorSlot<T>` に assignable でなくなる
 * (= structural mismatch でユーザーの全 generic が unknown に倒れる)。symbol を
 * 含む path は実 zod の runtime には現れないが、TS 型上は受け入れる必要がある。
 */
export type ValidatorIssue = {
  readonly path: ReadonlyArray<PropertyKey>;
  readonly message: string;
};

/**
 * Validator slot config。`params` / `data` slot ごとに schema を宣言する。
 * 旧 ADR 0071 の `validator(schema)` middleware は廃止、本 slot に統合。
 *
 * 拡張余地: 将来 `query` / `form` / `multipart` slot 追加可 (ADR 0073 論点 5)。
 * 今回は YAGNI で params + data の 2 個のみ。
 */
export type ValidatorConfig<Params, Data> = {
  readonly params?: ValidatorSlot<Params>;
  readonly data?: ValidatorSlot<Data>;
};

/**
 * serverFn config object (= ADR 0073 採用 form、流派 1 object 1 個渡し)。
 *
 * - `middleware` = ctx 構築用 middleware の配列、未指定なら空配列扱い
 * - `validator`  = { params, data } の zod schema map、未指定 slot は input をそのまま流す
 * - `handler`    = 必須、`({ params, data, ctx })` を受けて結果を返す本体
 */
export type ServerFnConfig<
  MWs extends readonly Middleware<Record<string, unknown>>[],
  Params,
  Data,
  R,
> = {
  readonly middleware?: MWs;
  readonly validator?: ValidatorConfig<Params, Data>;
  readonly handler: Handler<Params, Data, MergeCtx<MWs>, R>;
};

/**
 * `T` が `unknown` (= `any` 含む top type) かを判定する type-level helper。
 * ADR 0074: validator なし時に input arg を optional にするための判定軸。
 *
 * 仕組み: `unknown extends T` は `T` が `unknown` (or `any`) の時にだけ `true`。
 * specific 型 (= `{slug:string}` 等) には `unknown` は assignable じゃないので `false`。
 *
 *   IsUnknown<unknown>      → true
 *   IsUnknown<any>          → true (any は何でも互換、unknown 扱いで実害なし)
 *   IsUnknown<{slug:string}> → false
 *   IsUnknown<undefined>     → false (= 明示 undefined は input required を維持)
 *
 * 逆方向 (= `T extends unknown`) で書くと、specific 型も unknown に assignable
 * なので全部 true になる落とし穴がある。ADR 0074 Options 案 B 参照。
 */
type IsUnknown<T> = unknown extends T ? true : false;

/**
 * Public form (= client / 普通の呼び出し経路から見える signature)。
 * client bundle 経路では `__vidroServerFnStub("/url")` に置換、戻り値はこの型。
 *
 * ADR 0074: validator が両 slot とも指定されていない時 (= Params/Data 両方
 * unknown に倒れる) は input arg を **optional** に倒す (= `await listPosts()`
 * を許容)。validator あり (片方でも) は input required を維持して安全性を担保。
 *
 *   no-validator (Params=unknown, Data=unknown)            → optional
 *   params-only (Params=typed,   Data=unknown)             → required
 *   data-only   (Params=unknown, Data=typed)               → required
 *   both        (Params=typed,   Data=typed)               → required
 */
export type ServerFnPublic<Params, Data, R> =
  IsUnknown<Params> extends true
    ? IsUnknown<Data> extends true
      ? (input?: ServerFnInput<Params, Data>) => Promise<R>
      : (input: ServerFnInput<Params, Data>) => Promise<R>
    : (input: ServerFnInput<Params, Data>) => Promise<R>;

/**
 * Internal form (= unit test / dispatchServerFn から呼ばれる、c 末尾必須、
 * ADR 0072 の `.run(args, c)` pattern を維持)。
 */
export type ServerFnInternal<Params, Data, R> = (
  input: ServerFnInput<Params, Data>,
  c: Context,
) => Promise<R>;

/**
 * client が serverFn を呼ぶ時の入力 object。`{ params, data }` の slot を持つ。
 * URL 動的 segment が無い fn (= no params) でも params: {} が立つことを許容。
 */
export type ServerFnInput<Params, Data> = {
  readonly params?: Params;
  readonly data?: Data;
};

/**
 * `serverFn(config)` の戻り値 (= public form + `.run` で internal form 露出)。
 *
 *   - `(input)` 直呼出     → public form (= user code 経路、client bundle で stub 化)
 *   - `.run(input, c)`     → internal form (= unit test / dispatchServerFn 経路、c 末尾)
 *
 * runtime 実体は同一関数、`.run` は同関数への参照 (cast で internal form 型として露出)。
 */
export type ServerFn<Params, Data, R> = ServerFnPublic<Params, Data, R> & {
  readonly run: ServerFnInternal<Params, Data, R>;
};

/**
 * `serverFn(config)` factory。
 *
 * - `config.middleware` の chain を順に await、各 middleware が `next({ ctx })` で
 *   ctx を accumulate する (= TanStack Start 流の delta merge)
 * - `config.validator.params` / `config.validator.data` で input を schema parse、
 *   失敗時は 422 + `{ fields }` Response throw (ADR 0059 規約)
 * - `config.handler({ params, data, ctx })` を最後に呼んで結果を return
 * - middleware が `next()` を呼ばずに Response を返した場合は早期 return (= auth fail
 *   等)、Response を throw として呼出元 (= dispatchServerFn) に伝える
 *
 * @example
 * // server.ts
 * export const updatePost = serverFn({
 *   middleware: [authMw],
 *   validator: { params: paramsSchema, data: dataSchema },
 *   handler: async ({ params, data, ctx }) => {
 *     return db.posts.update(params.slug, data);
 *   },
 * });
 *
 * // client (bundler が __vidroServerFnStub に置換)
 * await updatePost({ params: { slug }, data: { title, body } });
 *
 * // unit test
 * const c = createContext({ request });
 * await updatePost.run({ params: { slug: "abc" }, data: { ... } }, c);
 */
export function serverFn<
  // `const MWs` (= TS 5.0 const type parameter) で middleware array を **tuple** として
  // infer させる。これが無いと `[mwA, mwB]` は `(typeof mwA | typeof mwB)[]` (= union
  // member の array) に推論され、MergeCtx<MWs> の tuple recursion が走らず ctx 型が
  // accumulate されない (= handler の ctx が never に倒れる)。
  const MWs extends readonly Middleware<Record<string, unknown>>[],
  Params,
  Data,
  R,
>(config: ServerFnConfig<MWs, Params, Data, R>): ServerFn<Params, Data, R> {
  const middlewares = (config.middleware ?? []) as readonly Middleware<Record<string, unknown>>[];
  const validatorParams = config.validator?.params;
  const validatorData = config.validator?.data;
  const handler = config.handler as Handler<unknown, unknown, Record<string, unknown>, R>;

  // internal form: c 末尾必須 (ADR 0072 path 継承)。dispatch / unit test から呼ばれる。
  // ADR 0074: input は optional。SSR 中の server-side 直 invoke (= `.server.tsx`
  // 内で `await listPosts()`) で undefined が渡る case を許容。client stub 経路
  // も同様に no-arg 呼出 → 内部 `{}` 扱い。validator あり fn は public form 型で
  // input required になっているので、ここでは defensive に default するだけ。
  const internalForm = async (
    input: ServerFnInput<unknown, unknown> | undefined,
    c: Context,
  ): Promise<R> => {
    const safeInput = input ?? {};
    // 1. validator: params / data を schema で parse、失敗時は 422 throw。
    //    旧 `c.var.body` 経路は廃止、input.data を直接 parse する経路に統合 (ADR 0073)。
    let params: unknown = safeInput.params;
    let data: unknown = safeInput.data;

    if (validatorParams) {
      const parsed = validatorParams.safeParse(safeInput.params);
      if (!parsed.success) {
        const fields = flattenZodFields(parsed.error);
        throw new Response(JSON.stringify({ fields, slot: "params" }), {
          status: 422,
          headers: { "content-type": "application/json" },
        });
      }
      params = parsed.data;
    }

    if (validatorData) {
      const parsed = validatorData.safeParse(safeInput.data);
      if (!parsed.success) {
        const fields = flattenZodFields(parsed.error);
        throw new Response(JSON.stringify({ fields, slot: "data" }), {
          status: 422,
          headers: { "content-type": "application/json" },
        });
      }
      data = parsed.data;
    }

    // 2. middleware chain を **onion 形式** で実行、最深部で handler を呼ぶ。
    //    各 middleware は `next({ ctx })` を呼ぶことで「自分の after コードを継続」
    //    として後段 (= 次 middleware or handler) を invoke する。next() を呼ばない
    //    middleware は handler に到達せず、Response を返した場合は早期 return として
    //    最上層に throw で伝える (= auth fail / 422 等)。
    //
    //   構造:
    //     runMiddleware(0)
    //       → mw1 before
    //       → next() ── runMiddleware(1)
    //                     → mw2 before
    //                     → next() ── runMiddleware(2 = base)
    //                                   → handler ← 最深部、戻り値を closure に保持
    //                     → mw2 after
    //       → mw1 after
    //     return handlerResult
    let ctx: Record<string, unknown> = {};
    let earlyResponse: Response | undefined;
    let handlerResult: R | undefined;
    let handlerCalled = false;

    const runMiddleware = async (idx: number): Promise<void> => {
      if (idx >= middlewares.length) {
        // base case: handler を呼ぶ (= onion 最深部)、c は渡さない (= 完全排除)。
        handlerCalled = true;
        handlerResult = await handler({ params, data, ctx });
        return;
      }
      const mw = middlewares[idx]!;
      let nextCalled = false;
      // runtime の next は generic 不要 (= 全 middleware の delta を共通型で受ける)。
      // 型上 NextDelta<Record<string, unknown>> で wide な ctx delta を許容する。
      const next = async (delta?: NextDelta<Record<string, unknown>>): Promise<void> => {
        if (nextCalled) {
          throw new Error(
            "[vidro/serverFn] middleware called next() multiple times " +
              "(double-dispatch is not supported, use a single next() call per middleware)",
          );
        }
        nextCalled = true;
        if (delta?.ctx) {
          ctx = { ...ctx, ...delta.ctx };
        }
        await runMiddleware(idx + 1);
      };
      const ret = await mw({ c, ctx, next });
      if (ret instanceof Response && !nextCalled) {
        // middleware が next() を呼ばずに Response 返した = 早期 return
        // (= auth fail / 422 等)、Response を throw に変換して呼出元に伝える。
        // next() 呼んだ後の Response 戻り値は無視する (= Hono と同形、chain semantics
        // 維持)。
        earlyResponse = ret;
      }
    };

    await runMiddleware(0);

    if (earlyResponse) {
      throw earlyResponse;
    }

    // 3. handler が呼ばれていれば戻り値を返す。呼ばれていない場合 (= broken
    //    middleware が next() も Response も返さなかった) は undefined を返す
    //    silent path。設計違反 detection は別 lint で補助する想定。
    if (!handlerCalled) {
      return undefined as unknown as R;
    }
    return handlerResult as R;
  };

  // runtime は internalForm、TS 型は public form + `.run` で internal form 露出。
  // `.run` は同 function への参照、cast で両 form を提供。
  const publicForm = internalForm as unknown as ServerFn<Params, Data, R>;
  Object.defineProperty(publicForm, "run", {
    value: internalForm,
    writable: false,
    enumerable: false,
    configurable: false,
  });
  return publicForm;
}

/**
 * validator error の `issues[]` を `{ field: message }` の flat record に変換。
 * 422 wire shape の `fields` 用 (ADR 0059)。zod / valibot 等 issues shape 互換であれば
 * 動く (= ValidatorIssue interface)。
 */
function flattenZodFields(error: {
  issues: ReadonlyArray<ValidatorIssue>;
}): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    // path は PropertyKey の配列 (zod 4.x で symbol も型上含む)、symbol 要素は
    // String() で `Symbol(name)` 文字列化されて key collision の risk があるため、
    // string / number 要素のみで join、それ以外を含む path は skip する。zod 実
    // runtime は string/number しか出さないので skip 経路は通常実行されない。
    if (!issue.path.every((p) => typeof p === "string" || typeof p === "number")) continue;
    const path = issue.path.join(".");
    if (path && !(path in fields)) {
      fields[path] = issue.message;
    }
  }
  return fields;
}

/**
 * Request + env + executionCtx から Context を構築する helper。
 *
 * dispatchServerFn / unit test 経路から呼ばれる。ALS scope (= ADR 0066
 * getRequestEnv) との統合は両方並行存続。
 *
 * env 解決規則:
 *   - 引数 `env` 明示 → そのまま使う
 *   - 引数 `env` 未指定 + ALS scope active (= getRequestEnv 経由) → ALS の env
 *   - 引数 `env` 未指定 + ALS scope なし → undefined
 */
export function createContext(options: {
  request: Request;
  env?: unknown;
  executionCtx?: ExecutionContext;
}): Context {
  const url = new URL(options.request.url);

  let env: unknown = options.env;
  if (env === undefined) {
    try {
      env = getRequestEnv();
    } catch {
      env = undefined;
    }
  }

  return {
    req: {
      url: options.request.url,
      headers: options.request.headers,
      query(key: string) {
        return url.searchParams.get(key) ?? undefined;
      },
    },
    env,
    executionCtx: options.executionCtx,
  };
}

// ---- Phase 2c: server runtime dispatch ----

/**
 * server bundle 経由で eager 登録される 1 server function entry。
 * URL template (= file path 由来、`[xxx]` を含む) と handler のペア。
 *
 * Plugin 側 (= @vidro/plugin の `routeTypes()`) が build 時に server-fn-manifest を
 * 生成、user の server entry が import して `createServerHandler` に渡す。
 *
 * `handler` は serverFn 戻り値の internal form (= `(input, c) => Promise<R>`、ADR 0073)。
 * dispatchServerFn が `{ params, data }` を decode して `(input, c)` で呼ぶ。
 */
export type ServerFnRuntimeEntry = {
  /** URL template (= 例: "/posts/[slug]/edit/updatePost") */
  url: string;
  /**
   * serverFn(...) 戻り値の internal form (= `(input, c) => Promise<R>`、ADR 0073)。
   * dispatchServerFn が `{ params, data }` を構築して `(input, c)` で呼ぶ。
   */
  handler: (input: ServerFnInput<unknown, unknown>, c: Context) => Promise<unknown>;
};

/**
 * URL template と実 URL pathname を match させ、`[xxx]` segment の値を順に
 * **`{ paramName: value }` の object** で返す (ADR 0073 採用 form)。
 *
 * 旧 ADR 0070 では positional 配列 `["abc"]` を返していたが、ADR 0073 で
 * `{ slug: "abc" }` の object 形に変更 (= handler の input.params に直接流せる形)。
 *
 * 例:
 *   matchServerFnUrl("/posts/[slug]/edit/updatePost", "/posts/abc/edit/updatePost")
 *     → { slug: "abc" }
 *   matchServerFnUrl("/posts/new/createPost", "/posts/new/createPost") → {}
 *   matchServerFnUrl("/posts/[slug]/edit/updatePost", "/posts/abc/delete/updatePost") → null
 *
 * 結果 object は decodeURIComponent 済 (= URL encoded を user code に渡る前に展開)。
 */
export function matchServerFnUrl(
  template: string,
  actualPathname: string,
): Record<string, string> | null {
  const tplParts = template.split("/");
  const actualParts = actualPathname.split("/");
  if (tplParts.length !== actualParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < tplParts.length; i++) {
    const tp = tplParts[i] ?? "";
    const ap = actualParts[i] ?? "";
    // dyn segment は `[name]` 形式で全体一致 (= partial match `/foo[bar]/x` は不採用)。
    // 空 `[]` (= length 2) は意味のない placeholder、length >= 3 で `[a]` 以上のみ採用。
    if (tp.length >= 3 && tp.startsWith("[") && tp.endsWith("]")) {
      const name = tp.slice(1, -1);
      try {
        params[name] = decodeURIComponent(ap);
      } catch {
        // invalid percent encoding → match 失敗扱い (= dispatchServerFn 側が次の
        // entry を試行できる構造)。
        return null;
      }
      continue;
    }
    if (tp !== ap) return null;
  }
  return params;
}

/**
 * 1 request に対して entries を順に試行、match した最初の entry の handler を呼ぶ。
 * 何にも match しなければ null を返す (= 呼出元が次の dispatch path を試行できる)。
 *
 * wire format (ADR 0073):
 *   - request body = JSON object `{ params?, data? }` (= `__vidroServerFnStub` が
 *     `JSON.stringify({ params, data })` で送る)
 *   - URL の dyn segment 値が `params` slot に object として merge される
 *     (= URL の `[slug]` → `params.slug`、body の params も同じ slot で受ける)
 *   - 戻り値: handler 結果を JSON.stringify、200 で返す
 *   - 戻り値 undefined → 204 No Content
 *   - middleware が `next()` 前に Response を返した (= 早期 return) → そのまま wire
 *   - 通常 throw → 500 + JSON {error}
 */
export async function dispatchServerFn(
  request: Request,
  entries: readonly ServerFnRuntimeEntry[],
  options: { env?: unknown; executionCtx?: ExecutionContext } = {},
): Promise<Response | null> {
  if (request.method !== "POST") return null;
  const url = new URL(request.url);

  for (const entry of entries) {
    const urlParams = matchServerFnUrl(entry.url, url.pathname);
    if (urlParams === null) continue;

    // body は JSON object `{ params?, data? }`。空 body は `{}` として解釈。
    let bodyInput: { params?: unknown; data?: unknown } = {};
    try {
      const text = await request.text();
      if (text.length > 0) {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          bodyInput = parsed as { params?: unknown; data?: unknown };
        } else {
          // 想定外 (= scalar / array) は 400
          return new Response(
            JSON.stringify({
              error: "[vidro] server function: body must be a JSON object { params?, data? }",
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }
      }
    } catch {
      return new Response(JSON.stringify({ error: "[vidro] server function: invalid JSON body" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    // params は URL 由来と body 由来の merge (= URL 優先、URL に [slug] があれば body
    // の params.slug は無視される設計、wire 規約として URL = source of truth)。
    // 通常 client stub は URL に埋めて body には params を含めない経路、defensive 用。
    const mergedParams = {
      ...(bodyInput.params as Record<string, unknown> | undefined),
      ...urlParams,
    };

    const c = createContext({
      request,
      env: options.env,
      executionCtx: options.executionCtx,
    });

    try {
      const result = await entry.handler({ params: mergedParams, data: bodyInput.data }, c);
      if (result === undefined) {
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (err) {
      // serverFn factory は middleware 早期 return + validator 失敗を Response throw
      // で表現する。Response を直接 wire 化する。
      if (err instanceof Response) return err;
      console.error("[vidro/dispatchServerFn] handler error:", err);
      return new Response(
        JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
  }

  return null;
}
