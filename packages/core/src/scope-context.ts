// per-render scope state を `await` を生き残らせる共通 helper (ADR 0065)。
//
// Vidro の各 scope (island / resource / suspense / streaming) は元々
// module-level の `let currentScope: T | null = null` を try/finally で push/pop
// する pattern だった。だが async function component の continuation は `await`
// 完了後に走るため、try/finally の finally がそれより先に pop してしまい、
// continuation 内で scope が null になる構造的問題があった (ADR 0066 着地の
// 障害)。
//
// 解決: server runtime (Node / Workers / Deno / Bun) では `AsyncLocalStorage`
// を使う。`als.run(value, fn)` は sync passthrough (= fn の return 値そのまま)
// + async 子孫に context が伝播 (= continuation でも `als.getStore()` で取れる)。
// browser には ALS が無いので、従来の sync state pattern にフォールバック
// (= browser では async function component を実行する経路が無いので、
// preservation 不要)。
//
// 採用方針 (ADR 0065 論点 1-A):
//   - raw `AsyncLocalStorage` を使う (= Workers / Node 両方で動く)
//   - `unctx` library は `callAsync` が常に Promise を返す制約があり、Vidro の
//     sync runWith API と衝突するため不採用 (= ADR 0065 Decision で 1-B 却下済)
//   - 将来 Nitro / unjs 路線に踏み込んだ時は本 helper 内部だけ unctx に
//     差し替え可能 (= callsite 影響ゼロ)
//
// 検出順序:
//   1. `globalThis.AsyncLocalStorage` (= 呼び出し元 entry が予め polyfill 済の場合)
//   2. `node:async_hooks` を dynamic import (= top-level await で sync 同等扱い、
//      Node / Workers / Deno / Bun で動く)
//   3. 両方 fail → browser / 古い runtime なので sync fallback
//
// Cloudflare Workers での enable: `compatibility_flags = ["nodejs_als"]`
// (or `nodejs_compat`) を wrangler.toml に追加する必要あり。

type ALSInstance<T> = {
  run<R>(store: T, fn: () => R): R;
  getStore(): T | undefined;
};

type ALSConstructor = { new <T>(): ALSInstance<T> };

// 1. globalThis 経由 (= 呼び出し元 polyfill 済 / Workers 一部環境)
let detected: ALSConstructor | undefined = (
  globalThis as unknown as { AsyncLocalStorage?: ALSConstructor }
).AsyncLocalStorage;

// 2. node:async_hooks を dynamic import で試す。top-level await で sync 同等。
//    server runtime (Node / Workers + nodejs_als / Deno / Bun) では成功、
//    browser では import 自体が失敗するので catch でスキップ。
if (!detected) {
  try {
    const mod = await import("node:async_hooks");
    detected = mod.AsyncLocalStorage as unknown as ALSConstructor;
  } catch {
    // browser や ALS 未対応 runtime → sync fallback で動く
  }
}

const ALS: ALSConstructor | undefined = detected;

export type Scope<T> = {
  /**
   * `value` を current scope にして fn を実行。fn が sync ならその return 値を
   * そのまま返す (= sync passthrough)、async (Promise) なら Promise<T> を返す。
   *
   * server runtime: ALS の `als.run(value, fn)` を呼ぶ。fn の async 子孫
   * (= `await` 後の continuation、setTimeout、microtask 等) でも `getCurrent()`
   * で同じ value が引ける。
   *
   * browser fallback: 古典的 push/pop。fn が sync なら問題なし、fn が async
   * でも `await` を超えて scope は引けない (= browser では async server
   * component を走らせる経路が無いので実害なし)。
   */
  runWith<R>(value: T, fn: () => R): R;

  /** active な scope value、無ければ null。 */
  getCurrent(): T | null;
};

export function createScope<T>(): Scope<T> {
  if (ALS) {
    const storage = new ALS<T>();
    return {
      runWith<R>(value: T, fn: () => R): R {
        return storage.run(value, fn);
      },
      getCurrent(): T | null {
        return storage.getStore() ?? null;
      },
    };
  }

  // browser fallback (= ALS 無し): module-level state + try/finally
  let current: T | null = null;
  return {
    runWith<R>(value: T, fn: () => R): R {
      const prev = current;
      current = value;
      try {
        return fn();
      } finally {
        current = prev;
      }
    },
    getCurrent(): T | null {
      return current;
    },
  };
}
