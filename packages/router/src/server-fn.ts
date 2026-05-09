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
 * serverFn factory の **internal form** (= context を第 1 引数で受ける形)。
 * server-side dispatch (= Phase 2c の dispatchServerFn) と unit test (= Phase 1
 * tests) が使う、user code が直接呼ぶ形ではない。
 */
export type ServerFnInternal<P extends readonly unknown[], R> = (
  c: Context,
  ...args: P
) => Promise<R>;

/**
 * serverFn factory の **public form** (= Phase 2c で user が import して呼ぶ形)。
 * 位置引数のみで context は省く (= server-side では bundler stub / dispatch が
 * c を inject、client-side では bundler stub が fetch wire 化)。
 */
export type ServerFnPublic<P extends readonly unknown[], R> = (...args: P) => Promise<R>;

/**
 * serverFn factory の戻り値型 (= public form + `.run` で internal form 露出)。
 *
 *   - `(...args)` 直呼出 → public form (= user code 経路、Phase 2c stub と signature 一致)
 *   - `.run(c, ...args)` → internal form (= unit test / dispatchServerFn 経路、c 明示)
 *
 * runtime 実体は同一関数を public form 型にキャストしたもので、`.run` は
 * 同じ関数への direct reference (= internal form 型のまま)。`createPost(input)` も
 * `createPost.run(c, input)` も runtime では `internalForm(c, ...rest)` を呼ぶ。
 *
 * client bundle 経路では `__vidroServerFnStub("/url")` に置換されて public form
 * のみが立つ (= `.run` は client 側に存在しない、stub の戻り値は普通の関数)。
 * client から `.run` を呼ぶと undefined エラー (= 想定外の使い方)。
 */
export type ServerFn<P extends readonly unknown[], R> = ServerFnPublic<P, R> & {
  /**
   * Internal form (= context を第 1 引数で受ける)。unit test と
   * dispatchServerFn (Phase 2c) が使う、client-side では存在しない。
   */
  readonly run: ServerFnInternal<P, R>;
};

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
 * 戻り値の **TS 型は public form** (`(...args: P) => Promise<R>`、= Phase 2c
 * の user code から見える形)。runtime 実体は internal form (= context が第 1
 * 引数) で、dispatchServerFn / Phase 1 unit test は `as unknown as
 * ServerFnInternal<P, R>` でキャストして c を渡す。
 *
 * @example
 * // Phase 7 dogfood の user 視点:
 * // server.ts
 * export const createPost = serverFn(async (c, input: Input) => {
 *   return db.posts.insert(input);
 * });
 *
 * // post-form.client.tsx
 * import { createPost } from "./server";
 * const post = await createPost(input); // public form、c を見せない
 *
 * @example
 * // unit test / direct invocation:
 * const fn = serverFn(async (c, name: string) => `hello ${name}`);
 * const c = createContext({ request });
 * const result = await (fn as unknown as ServerFnInternal<[name: string], string>)(c, "world");
 */
export function serverFn<P extends readonly unknown[], R>(
  ...args: ServerFnArgs<P, R>
): ServerFn<P, R> {
  // 最後が handler、残りが middleware (= TS variadic tuple の runtime 表現)
  const handler = args[args.length - 1] as Handler<P, R>;
  const middlewares = args.slice(0, -1) as Middleware[];

  const internalForm = async (c: Context, ...positionalArgs: P): Promise<R> => {
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

  // runtime は internal form (= c, ...args)、TS 型は public form + `.run` 経由で
  // internal form 露出。`.run` は同 function への参照、cast 重ねて両 form 提供。
  // Phase 2c の dispatchServerFn は `entry.handler(c, ...args)` 直呼出する経路で、
  // ServerFnRuntimeEntry["handler"] (= internal form) としての cast 済み。
  const publicForm = internalForm as unknown as ServerFn<P, R>;
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
 * internal form `(c, ...args) => Promise<R>`) のペア。
 *
 * Plugin 側 (= @vidro/plugin の `routeTypes()`) が build 時に discoverServerFns を
 * 走らせて `.vidro/server-fn-manifest.ts` を生成、そこから `serverFnManifest:
 * ServerFnRuntimeEntry[]` として export される。user の server entry が import
 * して `createServerHandler({ serverFns })` に渡す。
 *
 * 型は loose (= `unknown`)。実際の handler は具体型を持つが、registry レベルで
 * 列挙するため `(c, ...args: unknown[]) => Promise<unknown>` に統一。spread back
 * は server entry が body から JSON 配列として decode した結果を unknown[] として
 * 渡す経路。
 */
export type ServerFnRuntimeEntry = {
  /** URL template (= 例: "/posts/[slug]/edit/updatePost") */
  url: string;
  /** serverFn(...) 戻り値の internal form (= context + 位置引数で受ける) */
  handler: (c: Context, ...args: unknown[]) => Promise<unknown>;
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

    try {
      const result = await entry.handler(c, ...params, ...bodyArgs);
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
