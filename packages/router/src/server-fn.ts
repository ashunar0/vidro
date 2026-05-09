// ADR 0070 Phase 1 + ADR 0072: serverFn() factory + Hono c subset context.
//
// 本 file は Phase 1 のみで、bundler 拡張 (= Phase 2 で fetch stub generation)
// や directory middleware.ts 認識 (= Phase 3) は含めない。serverFn は server side
// で直接呼べる internal form (= context を末尾で受ける) として返るので、unit
// test 可能。Phase 2 で bundler が wrap して位置引数のみの public form
// (= `(...args) => Promise<R>`) として client / server 両側に export する。
//
// 設計判断 (ADR 0072 で改訂):
//   - handler signature は **`(...args: [...P, c?: Context]) => R`** (= c 末尾
//     optional)、9 割の handler は `(input) => R` の pure service form で書ける、
//     1 割の edge case (auth header / redirect 等) は `(input, c) => R` で対応
//     (ADR 0072 論点 1-C)
//   - middleware は Hono と同形 `(c, next) => ...` だが、`next(overrideArgs?)` で
//     handler の引数を override できる経路を追加 (= validator middleware の typed
//     input 渡しに使う、ADR 0072 論点 5-A)
//   - dispatch は handler を `handler(...currentArgs, c)` で呼ぶ (= c は必ず末尾、
//     ADR 0072 論点 3-A)
//   - 論点 7 (= 位置引数で dynamic param と body を受ける) は維持
//
// ADR 0072 partial supersede: ADR 0070 論点 6 (= handler が Hono c を第 1 引数で
// 受ける) は handler 層から外して middleware 層に閉じる。c subset 自体は維持。
//
// 関連 ADR: 0070 (server function pattern)、0072 (handler signature pure service
// form 改修)、0066 (async server component native で getRequestEnv が ALS で動く)、
// 0065 (scope context cross async)。

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
 * Hono Context の subset。ADR 0070 論点 6 で採用 API のみ。response builder
 * (= `c.json` / `c.text` / `c.redirect`) と body parser (= `c.req.json` /
 * `c.req.formData`) は不採用 (= 戻り値そのまま JSON 化、body は handler の
 * 引数で受ける)。
 *
 * `c.env` は既存 `getRequestEnv<T>()` (= ADR 0066 ALS scope) と統合される。
 * serverFn 内では `c.env` 推奨、ただし既存 code 互換のため `getRequestEnv()`
 * も並行存続する (= breaking change なし)。
 */
export type Context = {
  /**
   * request meta。URL / headers / query を引く。body は handler の引数で受ける
   * (= `c.req.json()` / `c.req.formData()` は不採用、Phase 2 bundler stub が
   * body を decode して位置引数として handler に渡す)。
   */
  readonly req: {
    readonly url: string;
    readonly headers: Headers;
    /** URL query string を取得 (= `?foo=bar` の `foo`)。dynamic param とは別経路。 */
    query(key: string): string | undefined;
  };
  /** middleware 間値受け渡し (= Hono と同形)。`c.var` でも参照可能。 */
  get<T = unknown>(key: string): T | undefined;
  set<T = unknown>(key: string, value: T): void;
  /** `c.get(key)` の syntactic alternative (= Hono と同形)、read-only view。 */
  readonly var: Record<string, unknown>;
  /**
   * Cloudflare bindings (= D1 / KV / R2 等) や任意の user 側 env。
   * 既存 `getRequestEnv<T>()` (= ALS scope) と統合: serverFn が context 構築時に
   * ALS の現在 env を inject する。引数 env が明示されていればそちらを優先。
   */
  readonly env: unknown;
  /**
   * Cloudflare execution context (= `waitUntil()` 等の background work)。
   * Workers 以外の runtime では undefined。
   */
  readonly executionCtx?: ExecutionContext;
};

/**
 * Middleware 関数。Hono の `Middleware` 同形式 + `next(overrideArgs?)` で
 * 次段以降の args を override できる経路追加 (ADR 0072 論点 5-A)。`c` を受けて
 * `next()` を呼んで chain を進める。`next()` を呼ばないと handler は実行されない
 * (= 早期 return 経路、auth で unauthorized response を返す等)。
 *
 * generic:
 *   - `TIn`  = 自分が前段から受け取る args の型 (= 通常 unknown)
 *   - `TOut` = 自分が次段に渡す args の型 (= validator(schema) なら z.infer<S>)
 *
 * generic は **marker 用途** (= validator 等 type 連鎖する middleware が
 * `Middleware<unknown, z.infer<S>>` で意図表明する)。core の dispatch logic は
 * generic を runtime で使わず、`next(overrideArgs)` の値で args を更新する。
 *
 * `next(overrideArgs)`:
 *   - 引数なし → 前段の args をそのまま次段に渡す (= 多くの middleware の経路)
 *   - 引数あり → 次段以降の args を `overrideArgs` で置き換える (= validator が
 *     `next([parsed.data])` で handler の input 引数を typed 値に置換する経路)
 *
 * 戻り値:
 *   - `void` / `Promise<void>` → chain 完了で handler に到達
 *   - `Response` (= `next()` を呼ばずに) → 早期 return (= handler skip)、Phase 2
 *     で wire 化される (= 4xx/5xx 等の意図的 status code、Hono の `c.json(..., 401)`
 *     相当)
 *   - `Response` (= `next()` を呼んだ後で) → **無視される** (= Hono と同形)。
 *     早期 return は「next() を呼ばないこと」で明示する設計。next() 後の戻り値で
 *     handler 結果を上書きできてしまうと chain semantics が崩れるため。
 */
// generic は marker 用途で runtime 不使用 → lint 抑止のため `_` prefix。
// validator(schema) などが `Middleware<unknown, z.infer<S>>` で意図表明する。
export type Middleware<_TIn = unknown, _TOut = _TIn> = (
  c: Context,
  next: (overrideArgs?: readonly unknown[]) => Promise<void>,
) => Promise<void | Response> | void | Response;

/**
 * Handler 関数。serverFn の最後の引数として渡す本体。user 定義の位置引数を受ける。
 * **`c` (Context) を末尾引数として書くか書かないかは user 自由** (ADR 0072 論点 1-C)。
 * 9 割の handler は `(input) => R` の pure service form で書けて、1 割の edge case
 * (auth header / redirect 等) は `(input, c: Context) => R` のように c を末尾で受ける。
 *
 * 型レベルでは Handler の `Args` が user の signature 全体 (= input only or
 * input + Context)。TS variadic tuple の推論で「c が optional」を表現すると
 * `(input: T)` の T を Context と曖昧化する事象が出るため、c の有無は user
 * signature 自体に委ねる pragma。public form (= bundler wrap 後の client 視点)
 * は `StripTrailingContext` で末尾 Context を除外、internal form (= dispatch
 * 経路) は `EnsureTrailingContext` で末尾 Context を保証する型変換。
 *
 * ADR 0070 論点 7: `[slug]` 等の dynamic route segment N 個は引数の最初の N 個に
 * inject される (= Phase 2 bundler が stub 生成時に振り分ける)。
 *
 * 例:
 *   `(input) => R`            → c 不要な pure service handler (= 9 割)
 *   `(input, c: Context) => R` → c を使う handler (= auth header 取得 等)
 *   `(slug, input) => R`      → dyn segment + body input、c 不要
 *   `(slug, input, c: Context) => R` → 全部 + c
 */
export type Handler<Args extends readonly unknown[], R> = (...args: Args) => Promise<R> | R;

/**
 * Args 末尾が Context (or Context | undefined) なら除外、それ以外なら as-is。
 * public form (= bundler stub と client 視点) で c を見せないために使う。
 *
 *   StripTrailingContext<[Input]>             = [Input]              (c なし)
 *   StripTrailingContext<[Input, Context]>    = [Input]              (c 除外)
 *   StripTrailingContext<[]>                  = []                   (空)
 */
type StripTrailingContext<Args extends readonly unknown[]> = Args extends readonly [
  ...infer Rest,
  infer Last,
]
  ? [Last] extends [Context | undefined]
    ? Rest
    : Args
  : Args;

/**
 * Args 末尾が Context (or Context | undefined) ならそのまま、それ以外なら末尾に
 * Context を追加。internal form (= dispatch / test 経路) で c を必ず受ける形を
 * 保証するために使う。
 *
 *   EnsureTrailingContext<[Input]>            = [Input, Context]     (c 追加)
 *   EnsureTrailingContext<[Input, Context]>   = [Input, Context]     (as-is)
 *   EnsureTrailingContext<[]>                 = [Context]            (c のみ)
 */
type EnsureTrailingContext<Args extends readonly unknown[]> = Args extends readonly [
  ...infer _Rest,
  infer Last,
]
  ? [Last] extends [Context | undefined]
    ? Args
    : readonly [...Args, Context]
  : readonly [Context];

/**
 * serverFn factory の **internal form** (= context を **末尾必須** で受ける形、
 * ADR 0072 論点 3-A)。server-side dispatch (= Phase 2c の dispatchServerFn) と
 * unit test が使う、user code が直接呼ぶ形ではない。
 *
 * Handler の Args が末尾に Context を含まない場合は末尾に Context を追加した形に
 * 変形 (= EnsureTrailingContext)。Args が既に Context を末尾に持つなら as-is。
 */
export type ServerFnInternal<Args extends readonly unknown[], R> = (
  ...args: EnsureTrailingContext<Args>
) => Promise<R>;

/**
 * serverFn factory の **public form** (= Phase 2c で user が import して呼ぶ形)。
 * 位置引数のみで context は省く (= server-side では bundler stub / dispatch が
 * c を inject、client-side では bundler stub が fetch wire 化)。
 *
 * Handler の Args 末尾に Context があれば除外 (= StripTrailingContext)、これで
 * client 視点の signature に c が現れない。
 */
export type ServerFnPublic<Args extends readonly unknown[], R> = (
  ...args: StripTrailingContext<Args>
) => Promise<R>;

/**
 * serverFn factory の戻り値型 (= public form + `.run` で internal form 露出)。
 *
 *   - `(...args)` 直呼出 → public form (= user code 経路、Phase 2c stub と signature 一致、c 隠れる)
 *   - `.run(...args, c)` → internal form (= unit test / dispatchServerFn 経路、c 末尾明示、ADR 0072 論点 3-A)
 *
 * runtime 実体は同一関数を public form 型にキャストしたもので、`.run` は
 * 同じ関数への direct reference (= internal form 型のまま)。`createPost(input)` も
 * `createPost.run(input, c)` も runtime では `internalForm(...args, c)` を呼ぶ。
 *
 * client bundle 経路では `__vidroServerFnStub("/url")` に置換されて public form
 * のみが立つ (= `.run` は client 側に存在しない、stub の戻り値は普通の関数)。
 * client から `.run` を呼ぶと undefined エラー (= 想定外の使い方)。
 */
export type ServerFn<Args extends readonly unknown[], R> = ServerFnPublic<Args, R> & {
  /**
   * Internal form (= context を末尾必須で受ける、ADR 0072 論点 3-A)。unit test と
   * dispatchServerFn (Phase 2c) が使う、client-side では存在しない。
   */
  readonly run: ServerFnInternal<Args, R>;
};

/**
 * `serverFn(...mw, handler)` の引数型。最後が Handler、それ以外は Middleware
 * (= Hono `app.post(mw, h)` 同形式の typed rest)。TS の variadic tuple types
 * で表現。
 *
 * Middleware は generic を緩く `Middleware<unknown, unknown>` で受ける。validator
 * 等 type 連鎖を意図する middleware は `Middleware<unknown, T>` で自分の output
 * を表明できるが、core の dispatch logic は generic を runtime で使わない
 * (ADR 0072 論点 5-A、type 連鎖は別途 overload 等で実装する)。
 *
 * 例:
 *   serverFn(handler)                       → middleware なし
 *   serverFn(authMw, handler)               → 1 middleware
 *   serverFn(authMw, rateLimit, handler)    → 2 middleware
 *   serverFn(validator(schema), handler)    → validator が input override (ADR 0072)
 */
type ServerFnArgs<Args extends readonly unknown[], R> = readonly [
  ...Middleware<unknown, unknown>[],
  Handler<Args, R>,
];

/**
 * `serverFn(...mw, handler)` factory。
 *
 * - middleware を chain で実行、`next(overrideArgs?)` を呼ぶことで次の middleware
 *   → 最終的に handler に到達 (= koa/express/hono の onion model)
 * - middleware が `next()` を呼ばずに早期 Response return すると handler は実行
 *   されず、Response が呼出元に伝わる (= auth fail / 422 等)
 * - middleware が `next([newInput])` で次段の args を override できる
 *   (= validator middleware が typed input を handler に渡す経路、ADR 0072 論点 5-A)
 * - handler の戻り値が serverFn の戻り値として返る (= Phase 2 で JSON wire 化)
 *
 * 戻り値の **TS 型は public form** (`(...args: P) => Promise<R>`、= Phase 2c
 * の user code から見える形)。runtime 実体は internal form (= context が末尾、
 * ADR 0072 論点 3-A) で、dispatchServerFn / unit test は `.run(...args, c)` で
 * 呼ぶ経路を取る。
 *
 * @example
 * // Phase 7 dogfood の user 視点 (ADR 0072 Path 4):
 * // server.ts
 * export const createPost = serverFn(validator(schema), async (input: Input) => {
 *   return db.posts.insert(input);
 * });
 *
 * // post-form.tsx
 * import { createPost } from "./server";
 * const post = await createPost(input); // public form、c を見せない
 *
 * @example
 * // unit test / direct invocation:
 * const fn = serverFn(async (name: string) => `hello ${name}`);
 * const c = createContext({ request });
 * const result = await fn.run("world", c); // c は末尾必須
 */
export function serverFn<Args extends readonly unknown[], R>(
  ...args: ServerFnArgs<Args, R>
): ServerFn<Args, R> {
  // 最後が handler、残りが middleware (= TS variadic tuple の runtime 表現)。
  // handler は Args 型 signature を持つが、dispatch から `(...args, c)` で呼ぶため
  // 内部では variadic unknown[] で扱う。Args が末尾に Context を含むなら c が bind、
  // 含まないなら c は extra arg として variadic で無視される (= runtime safe)。
  const handler = args[args.length - 1] as (...allArgs: unknown[]) => Promise<R> | R;
  const middlewares = args.slice(0, -1) as Middleware<unknown, unknown>[];

  // internal form: c 末尾必須 (ADR 0072 論点 3-A)。dispatch / test から呼ばれる。
  const internalForm = async (...allArgs: unknown[]): Promise<R> => {
    if (allArgs.length === 0) {
      throw new Error(
        "[vidro/serverFn] internal form must be called with Context as the last argument",
      );
    }
    const c = allArgs[allArgs.length - 1] as Context;
    const initialArgs = allArgs.slice(0, -1);

    let result: R | undefined;
    let resultSet = false;
    let earlyResponse: Response | undefined;

    // chain を再帰で組み立てる: idx 番目 middleware を呼び、その next() で
    // idx + 1 番目を呼ぶ。最後の next() で handler を呼ぶ。currentArgs は
    // middleware が next(overrideArgs) で更新できる (= validator middleware が
    // typed input を handler に渡すための経路、ADR 0072 論点 5-A)。
    const dispatch = async (idx: number, currentArgs: readonly unknown[]): Promise<void> => {
      if (idx >= middlewares.length) {
        // chain 終端 → handler 呼び出し (c は末尾、ADR 0072 論点 3-A)。
        // handler signature が `(input)` なら c は variadic で無視、`(input, c)` なら bind。
        result = await handler(...currentArgs, c);
        resultSet = true;
        return;
      }
      const mw = middlewares[idx]!;
      let nextCalled = false;
      const next = async (overrideArgs?: readonly unknown[]) => {
        if (nextCalled) {
          throw new Error(
            "[vidro/serverFn] middleware called next() multiple times " +
              "(double-dispatch is not supported, use a single next() call per middleware)",
          );
        }
        nextCalled = true;
        // override が明示されていればそちらを使う、無ければ前段の args を継承
        // (= 多くの middleware は args に手を入れない)。validator middleware は
        // next([parsedInput]) で handler input を typed 値に置き換える経路。
        const nextArgs = overrideArgs ?? currentArgs;
        await dispatch(idx + 1, nextArgs);
      };
      const ret = await mw(c, next);
      if (ret instanceof Response && !nextCalled) {
        // middleware が next() を呼ばずに Response 返した = 早期 return
        // (= auth fail / 422 等)。直近の Response を保持して chain unwind 後に
        // throw として上に伝える。Phase 2 で server entry が catch して wire に
        // 流す経路を整備。
        //
        // next() 呼んだ後の Response 戻り値は無視する (= Hono と同形)。chain を
        // 進めた後で handler 戻り値を上書きできてしまうと semantics が崩れる:
        // 早期 return は「next() を呼ばないこと」で明示する設計。
        earlyResponse = ret;
      }
    };

    await dispatch(0, initialArgs);

    if (earlyResponse) {
      // Phase 1 では throw で表現。Phase 2 で server entry がこの throw を
      // catch して fetch wire に Response として流す経路を実装する (= 直接
      // Response 返す経路を別途整備しても良い、論点)。
      throw earlyResponse;
    }
    if (!resultSet) {
      // middleware が next() を呼ばず、Response も返さなかった (= 設計違反)。
      // user に明確に「middleware は next() か Response を返せ」と通知する。
      throw new Error(
        "[vidro/serverFn] middleware did not call next() and did not return Response. " +
          "Each middleware must either call next() to continue the chain, " +
          "or return a Response to short-circuit.",
      );
    }
    return result as R;
  };

  // runtime は internal form (= ...args, c 末尾)、TS 型は public form + `.run` 経由
  // で internal form 露出。`.run` は同 function への参照、cast 重ねて両 form 提供。
  // Phase 2c の dispatchServerFn は `entry.handler(...args, c)` 直呼出する経路で、
  // ServerFnRuntimeEntry["handler"] (= internal form) としての cast 済み。
  const publicForm = internalForm as unknown as ServerFn<Args, R>;
  Object.defineProperty(publicForm, "run", {
    value: internalForm,
    writable: false,
    enumerable: false,
    configurable: false,
  });
  return publicForm;
}

/**
 * Request + env + executionCtx から Context を構築する helper。
 *
 * Phase 2c で server entry の dispatch path から呼ばれる、Phase 1 では unit test /
 * server-side 直接呼び出し用に export していた。ALS との統合は両方並行存続。
 *
 * env 解決規則:
 *   - 引数 `env` 明示 → そのまま使う
 *   - 引数 `env` 未指定 + ALS scope active (= getRequestEnv 経由) → ALS の env
 *   - 引数 `env` 未指定 + ALS scope なし → undefined (= unit test 等の経路)
 *
 * これで既存 `getRequestEnv<T>()` 経路から呼ばれる serverFn でも c.env が引ける
 * (= breaking change なし、両方並行存続)。
 */
export function createContext(options: {
  request: Request;
  env?: unknown;
  executionCtx?: ExecutionContext;
}): Context {
  const url = new URL(options.request.url);
  const vars: Record<string, unknown> = {};

  // env: 引数優先、未指定なら ALS scope から拾う。ALS scope 外で getRequestEnv
  // は throw するので catch して undefined にする。
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
    get<T = unknown>(key: string): T | undefined {
      return vars[key] as T | undefined;
    },
    set<T = unknown>(key: string, value: T) {
      vars[key] = value;
    },
    var: vars,
    env,
    executionCtx: options.executionCtx,
  };
}

// ---- Phase 2c: server runtime dispatch ----

/**
 * Phase 2c: server bundle 経由で eager 登録される 1 server function entry。
 * URL template (= file path 由来、`[xxx]` を含む) と handler (= serverFn 戻り値の
 * internal form `(...args, c) => Promise<R>`、c 末尾、ADR 0072 論点 3-A) のペア。
 *
 * Plugin 側 (= @vidro/plugin の `routeTypes()`) が build 時に discoverServerFns を
 * 走らせて `.vidro/server-fn-manifest.ts` を生成、そこから `serverFnManifest:
 * ServerFnRuntimeEntry[]` として export される。user の server entry が import
 * して `createServerHandler({ serverFns })` に渡す。
 *
 * 型は loose (= `unknown`)。実際の handler は具体型を持つが、registry レベルで
 * 列挙するため `(...args: unknown[]) => Promise<unknown>` に統一 (末尾の args が
 * c という規約は doc レベル)。spread back は server entry が body から JSON 配列
 * として decode した結果を unknown[] として渡す経路。
 */
export type ServerFnRuntimeEntry = {
  /** URL template (= 例: "/posts/[slug]/edit/updatePost") */
  url: string;
  /**
   * serverFn(...) 戻り値の internal form (= 位置引数 + c 末尾で受ける、ADR 0072
   * 論点 3-A)。dispatchServerFn が `handler(...params, ...bodyArgs, c)` で呼ぶ。
   * readonly unknown[] で受けることで ServerFnInternal<Args, R> (= readonly tuple)
   * からも assign 可能 (= variance 緩和)。
   */
  handler: (...args: readonly unknown[]) => Promise<unknown>;
};

/**
 * URL template と実 URL pathname を match させ、`[xxx]` segment の値を順に
 * 配列で返す。**static segment が一致しなければ null**。
 *
 * 例:
 *   matchServerFnUrl("/posts/[slug]/edit/updatePost", "/posts/abc/edit/updatePost")
 *     → ["abc"]
 *   matchServerFnUrl("/posts/new/createPost", "/posts/new/createPost") → []
 *   matchServerFnUrl("/posts/[slug]/edit/updatePost", "/posts/abc/delete/updatePost") → null
 *   matchServerFnUrl("/foo/bar", "/foo") → null (= segment 数違い)
 *
 * ADR 0070 論点 7-A の位置引数対応 (= dyn segment N 個 → 引数の最初の N 個)。
 * 結果配列は decodeURIComponent 済 (= URL encoded を user code に渡る前に展開)。
 */
export function matchServerFnUrl(template: string, actualPathname: string): string[] | null {
  const tplParts = template.split("/");
  const actualParts = actualPathname.split("/");
  if (tplParts.length !== actualParts.length) return null;

  const params: string[] = [];
  for (let i = 0; i < tplParts.length; i++) {
    const tp = tplParts[i] ?? "";
    const ap = actualParts[i] ?? "";
    // dyn segment は `[name]` 形式で全体一致 (= partial match `/foo[bar]/x` は不採用)。
    // 空 `[]` (= length 2) は意味のない placeholder なので static 扱いに倒す
    // (= file path 上 `[]` directory が作れる environment でも user 想定外、
    // length >= 3 で `[a]` 以上のみ採用)。
    if (tp.length >= 3 && tp.startsWith("[") && tp.endsWith("]")) {
      // ap に invalid percent encoding (= `%GG` 等) が含まれると
      // decodeURIComponent が URIError を throw するので、catch して match 失敗
      // 扱いに倒す。dispatchServerFn 側で 400 を返すより、match させずに次の
      // entry を試行できる構造の方が defensive。最終的にどの entry にも match
      // しなければ呼出元 (= createServerHandler) が次の path に流す。
      try {
        params.push(decodeURIComponent(ap));
      } catch {
        return null;
      }
      continue;
    }
    if (tp !== ap) return null;
  }
  return params;
}

/**
 * 1 request に対して entries を順に試行、match した最初の entry の handler を
 * 呼ぶ。何にも match しなければ null を返す (= 呼出元が次の dispatch path を試行
 * できる、ADR 0068 action / navigation 等の既存経路を壊さない)。
 *
 * wire format:
 *   - request body = JSON 配列 (= body 引数の列、`__vidroServerFnStub` が
 *     `JSON.stringify(args.slice(i))` で送る)
 *   - URL の dyn segment 値が引数の最初の N 個に振られる
 *   - 戻り値: handler 結果を JSON.stringify、200 で返す
 *   - 戻り値 undefined → 204 No Content
 *   - middleware が `next()` 前に Response を返した (= 早期 return) → そのまま
 *     wire (= Phase 1 が throw earlyResponse、本 fn が catch して return)
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
    const params = matchServerFnUrl(entry.url, url.pathname);
    if (params === null) continue;

    // body は JSON 配列。空 body は [] として解釈 (= 引数なしの fn を許容)。
    let bodyArgs: unknown[] = [];
    try {
      const text = await request.text();
      if (text.length > 0) {
        const parsed: unknown = JSON.parse(text);
        if (Array.isArray(parsed)) {
          bodyArgs = parsed;
        } else {
          // legacy / 想定外 (= scalar や object 単体) は 1 引数として spread back
          bodyArgs = [parsed];
        }
      }
    } catch {
      return new Response(JSON.stringify({ error: "[vidro] server function: invalid JSON body" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    const c = createContext({
      request,
      env: options.env,
      executionCtx: options.executionCtx,
    });

    // body args を c.var.body に詰める (= validator middleware が schema parse する
    // ために参照する経路、ADR 0072 論点 5-A)。bodyArgs.length === 1 なら通常の
    // input 1 個 case で raw を入れる、複数 (= 想定外 / legacy) は配列ごと入れる。
    // **bodyArgs.length === 0 (= 引数なし fn) は set しない** (= c.var.body は
    // undefined のまま)。validator(schema) middleware は input ある fn 専用前提で
    // 運用 — 引数なし fn に validator を付けると `schema.safeParse(undefined)` が
    // 走って 422 を返してしまう (= ADR 0072 review 60th session で指摘あり、
    // Phase 6 `@vidro/zod` 実装時に validator 例コードでも明示する)。
    if (bodyArgs.length === 1) {
      c.set("body", bodyArgs[0]);
    } else if (bodyArgs.length > 1) {
      c.set("body", bodyArgs);
    }

    try {
      // handler 呼び出し: dyn segment (= params) + body (= bodyArgs) + c (= 末尾、
      // ADR 0072 論点 3-A)。handler signature が c を受けない場合 (= pure service
      // form `(input) => R`) も TS variadic で安全に無視される。
      const result = await entry.handler(...params, ...bodyArgs, c);
      if (result === undefined) {
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (err) {
      // serverFn factory は middleware 早期 return を Response throw で表現する
      // (= server-fn.ts の dispatch 内 `throw earlyResponse`)。Response を直接
      // wire 化する。
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
