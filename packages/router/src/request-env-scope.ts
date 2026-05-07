// per-request env binding (= Cloudflare Workers の `env` parameter 等) を保持する
// AsyncLocalStorage scope。`createServerHandler` が handler 受け取り時に
// `runWithRequestEnv(env, () => actualHandler())` で wrap し、user 側 `.server.ts` /
// loader / action / async function component から `getRequestEnv<MyEnv>()` で取れる。
//
// 用途:
//   - D1 / KV / R2 binding を per-request 取得 (= Workers `env.DB` 等)
//   - 環境別 secret (= `env.API_KEY`) を server-only 経路で参照
//   - 任意の user 側 context (= `ctx.env: MyEnv`) を route 全域で共有
//
// 実装は @vidro/core の `createScope` (= ADR 0065 で raw AsyncLocalStorage + browser
// fallback を統一した helper) を再利用。Workers / Node / Deno / Bun では ALS が
// 立つので、async function component の `await db.findAll()` 等 (= ADR 0066) でも
// continuation 内で env が引ける。
//
// browser では env は意味を成さない (= server-only 概念) ので fallback の
// module-level state は「sync 経路では引ける、await 越しは引けない」となるが、
// browser で getRequestEnv を呼ぶ user code 自体が anti-pattern (= 該当箇所は
// `.server.ts` に切り出すか、resource() 経由で fetch する設計)。

import { createScope } from "@vidro/core";

const requestEnvScope = createScope<unknown>();

/**
 * env を active にして fn を評価。`createServerHandler` が wrap で使う internal
 * API (= user 側からは直接呼ばない)。fn の中身が async でも `await` 越しに
 * `getRequestEnv()` で同じ env が引ける (= ALS 経由)。
 */
export function runWithRequestEnv<T>(env: unknown, fn: () => T): T {
  return requestEnvScope.runWith(env, fn);
}

/**
 * 現在 active な request env を返す。`.server.ts` / loader / action / async function
 * component (= ADR 0066) 内から呼ぶ。Generic で user が型 assertion する形:
 *
 * ```ts
 * type Env = { DB: D1Database; KV: KVNamespace };
 * const env = getRequestEnv<Env>();
 * const posts = await env.DB.prepare("SELECT * FROM posts").all();
 * ```
 *
 * scope 外 (= handler を経由しない経路 / browser) で呼ぶと throw する fail-fast。
 * Vidro は「動かない経路は早く・大きく失敗させる」方針 (memory `project_legibility_test`
 * のmagic 許容基準 + Q3 always throw 等の整合)。
 */
export function getRequestEnv<Env = unknown>(): Env {
  const env = requestEnvScope.getCurrent();
  if (env === null || env === undefined) {
    throw new Error(
      "[vidro] getRequestEnv() called outside of request scope. " +
        "It must be called within a route handler / loader / action / .server.tsx component, " +
        "and the server entry must pass `env` to the handler context.",
    );
  }
  return env as Env;
}
