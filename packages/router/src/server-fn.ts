// ADR 0070 Phase 1: serverFn() factory + Hono c subset context.
//
// 本 file は Phase 1 のみで、bundler 拡張 (= Phase 2 で fetch stub generation)
// や directory middleware.ts 認識 (= Phase 3) は含めない。serverFn は server side
// で直接呼べる internal form (= context を引数で受ける) として返るので、unit
// test 可能。Phase 2 で bundler が wrap して位置引数のみの public form
// (= `(...args) => Promise<R>`) として client / server 両側に export する。
//
// 設計判断: ADR 0070 論点 1 (= server.ts / *.server.tsx named export + serverFn
// wrapper)、論点 6 (= Hono c subset、response builder と body parser を引く)、
// 論点 7 (= 位置引数で dynamic param と body を受ける)。
//
// 関連 ADR: 0070 (server function pattern)、0066 (async server component native
// で getRequestEnv が ALS で動く)、0065 (scope context cross async)。

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
 * Middleware 関数。Hono の `Middleware` 同形式で、`c` を受けて `next()` を
 * 呼んで chain を進める。`next()` を呼ばないと handler は実行されない (= 早期
 * return 経路、auth で unauthorized response を返す等)。
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
export type Middleware = (
  c: Context,
  next: () => Promise<void>,
) => Promise<void | Response> | void | Response;

/**
 * Handler 関数。serverFn の最後の引数として渡す本体。`c` (= context) と user
 * 定義の位置引数を受けて値を返す。
 *
 * ADR 0070 論点 7: `[slug]` 等の dynamic route segment N 個は引数の最初の N 個に
 * inject される (= Phase 2 bundler が stub 生成時に振り分ける)。Phase 1 では
 * 位置引数を passthrough する内部 form。
 */
export type Handler<P extends readonly unknown[], R> = (c: Context, ...args: P) => Promise<R> | R;

/**
 * serverFn factory が返す internal form (= server-side direct invocation 用)。
 * Phase 2 で bundler が wrap して `(...args: P) => Promise<R>` (= 位置引数のみの
 * public form) として export する。本 type は internal、user code が直接見る
 * のは Phase 2 で wrap された後の form。
 */
export type ServerFnInternal<P extends readonly unknown[], R> = (
  c: Context,
  ...args: P
) => Promise<R>;

/**
 * `serverFn(...mw, handler)` の引数型。最後が Handler、それ以外は Middleware
 * (= Hono `app.post(mw, h)` 同形式の typed rest)。TS の variadic tuple types
 * で表現。
 *
 * 例:
 *   serverFn(handler)                       → middleware なし
 *   serverFn(authMw, handler)               → 1 middleware
 *   serverFn(authMw, rateLimit, handler)    → 2 middleware
 */
type ServerFnArgs<P extends readonly unknown[], R> = readonly [...Middleware[], Handler<P, R>];

/**
 * `serverFn(...mw, handler)` factory。
 *
 * - middleware を chain で実行、`next()` を呼ぶことで次の middleware → 最終的に
 *   handler に到達 (= koa/express/hono の onion model)
 * - middleware が `next()` を呼ばずに早期 Response return すると handler は実行
 *   されず、Response が呼出元に伝わる (= auth fail / 422 等)
 * - handler の戻り値が serverFn の戻り値として返る (= Phase 2 で JSON wire 化)
 *
 * Phase 1 では context (`c`) を引数で受ける internal form として定義。Phase 2
 * で bundler が `c` 構築 + wrapping を行い、user code から見える form は
 * `(...args: P) => Promise<R>` になる。
 *
 * @example
 * // Phase 1 の direct invocation 形式 (= unit test / server-side direct call):
 * const updatePost = serverFn(
 *   authMw,
 *   async (c, slug: string, input: { title: string }) => {
 *     return db.posts.update(slug, input);
 *   },
 * );
 * const c = createContext({ request, env, executionCtx });
 * const result = await updatePost(c, "abc-slug", { title: "Hello" });
 */
export function serverFn<P extends readonly unknown[], R>(
  ...args: ServerFnArgs<P, R>
): ServerFnInternal<P, R> {
  // 最後が handler、残りが middleware (= TS variadic tuple の runtime 表現)
  const handler = args[args.length - 1] as Handler<P, R>;
  const middlewares = args.slice(0, -1) as Middleware[];

  return async (c: Context, ...positionalArgs: P): Promise<R> => {
    let result: R | undefined;
    let resultSet = false;
    let earlyResponse: Response | undefined;

    // chain を再帰で組み立てる: idx 番目 middleware を呼び、その next() で
    // idx + 1 番目を呼ぶ。最後の next() で handler を呼ぶ。
    const dispatch = async (idx: number): Promise<void> => {
      if (idx >= middlewares.length) {
        // chain 終端 → handler 呼び出し
        result = await handler(c, ...positionalArgs);
        resultSet = true;
        return;
      }
      const mw = middlewares[idx]!;
      let nextCalled = false;
      const next = async () => {
        if (nextCalled) {
          throw new Error(
            "[vidro/serverFn] middleware called next() multiple times " +
              "(double-dispatch is not supported, use a single next() call per middleware)",
          );
        }
        nextCalled = true;
        await dispatch(idx + 1);
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

    await dispatch(0);

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
}

/**
 * Request + env + executionCtx から Context を構築する helper。
 *
 * Phase 2 で bundler が server entry で context を自動構築する経路を組むが、
 * Phase 1 では unit test / server-side 直接呼び出し用に export する。
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
