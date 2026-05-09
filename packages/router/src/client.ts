import { hydrate } from "@vidro/core";
import { Router } from "./router";
import type { RouteRecord } from "./route-tree";
import { setupIslandHydration } from "./island";

// ADR 0070 Phase 2b: bundler が生成する client side stub の runtime 部品。
//
// server.ts / *.server.tsx 内の `serverFn(...)` named export は、client bundle
// pass で `__vidroServerFnStub("/url-template")` 呼び出しに置換される (= plugin
// 側 transformServerFnSourceForClient)。本 helper は URL template の動的
// segment を引数 [0..N-1] で置換、残り引数を JSON 配列として body に詰めて
// POST 1 回 → JSON parse する thin wrapper。
//
// URL template の `[xxx]` segment は file path 由来 (= ADR 0070 論点 4-A、
// `routes/posts/[slug]/edit/server.ts` → `/posts/[slug]/edit/updatePost`)。
// 引数 0..N-1 が dyn segment、残りが body args (= 通常 1 個の input object、
// ADR 0070 論点 7-A)。
//
// design notes:
//   - 戻り値は content-type で判定: application/json なら res.json()、
//     204 No Content なら undefined、それ以外は text として返す
//   - error は res.ok === false なら throw、status + body の詳細は ServerFnError
//     等の専用 class 化を Open Question として保留
//   - middleware が早期 return した Response は普通に !ok or 4xx として降りてくる
//     (= Phase 1 の throw earlyResponse は server entry が catch → wire に流す)

/**
 * bundler 生成 stub の runtime 実体。`urlTemplate` は file path 由来の URL
 * (= 例: `/posts/[slug]/edit/updatePost`) を受け取り、引数で `[xxx]` を埋めて
 * POST + JSON wire を行う関数を返す。
 *
 * 通常 user は直接呼ばない (= bundler が `import { fn } from "./server"` を
 * `__vidroServerFnStub("/url")` 呼び出しに置換する経路で使われる)。
 */
export function __vidroServerFnStub(urlTemplate: string): (...args: unknown[]) => Promise<unknown> {
  return async (...args: unknown[]): Promise<unknown> => {
    let i = 0;
    // [xxx] segment を順に args[i] で置換。null / undefined / object は不正値
    // として throw (= 空文字 fallback は `/posts//edit/...` を生んで silent に
    // 404 化する debug 困難パターン、object は `[object Object]` URL になる)。
    // user の引数誤りを早く可視化することを優先 (= 想定外を生やさない)。
    const url = urlTemplate.replace(/\[(\w+)\]/g, (_match, name: string) => {
      const v = args[i++];
      if (v === null || v === undefined) {
        throw new Error(
          `[vidro] server function ${urlTemplate}: dynamic segment "${name}" is ${
            v === null ? "null" : "undefined"
          }, expected string|number|boolean|bigint.`,
        );
      }
      const tv = typeof v;
      if (tv === "string") return encodeURIComponent(v as string);
      if (tv === "number" || tv === "boolean" || tv === "bigint") {
        return encodeURIComponent(String(v));
      }
      throw new Error(
        `[vidro] server function ${urlTemplate}: dynamic segment "${name}" expects ` +
          `string|number|boolean|bigint, got ${tv}.`,
      );
    });
    // 残った引数は body 用 (= 通常 1 個の input object、複数も配列で送って server
    // side で spread back する設計)。0 個なら空配列で OK。
    const body = args.slice(i);
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      // body が読めれば message として混ぜる、駄目なら status 番号だけで例外。
      // 詳細 error class 化は Open Question (ADR 0070 #6)、当面は plain Error。
      const text = await res.text().catch(() => "");
      throw new Error(
        `[vidro] server function ${urlTemplate} failed: ${res.status} ${res.statusText}` +
          (text ? `\n${text.slice(0, 500)}` : ""),
      );
    }
    if (res.status === 204) return undefined;
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) return await res.json();
    return await res.text();
  };
}

// `<head>` 経由の inline trigger と client bundle の load 順序競合を捌く registry
// (ADR 0036)。boot() がここに登録 / 参照する。
declare global {
  interface Window {
    __vidroBoot?: () => void;
    __vidroBootPending?: boolean;
  }
}

/**
 * Vidro app の bootstrap helper (ADR 0044)。user の `src/main.tsx` から:
 *
 * ```ts
 * import { boot } from "@vidro/router/client";
 * boot(import.meta.glob("./routes/**\/*.{ts,tsx}", { eager: true }));
 * ```
 *
 * 内包する責務:
 *   - eagerModules → lazy `RouteRecord` 派生 (Vite の glob 重複 warning 回避、ADR 0027)
 *   - `#app` 探索 + 不在時 throw
 *   - ADR 0036 の boot registry idiom (bundle / shell trigger の load 順序競合)
 *   - `DOMContentLoaded` fallback と即発火 fallback (dev / 遅延読込時)
 *   - `booted` flag による 2 重発火ガード
 *
 * これらは全て framework 内部の race / convention であり、user code には漏らさない。
 */
export function boot(eagerModules: Record<string, unknown>): void {
  // lazy 形式は同 set からの派生で済ませる (Vite の同 glob 重複 warning 回避)。
  const routes: RouteRecord = Object.fromEntries(
    Object.entries(eagerModules).map(([k, m]) => [k, () => Promise.resolve(m)]),
  );

  const root = document.querySelector<HTMLDivElement>("#app");
  if (!root) throw new Error("#app not found");

  let booted = false;
  const fire = (): void => {
    if (booted) return;
    booted = true;
    // Router は component 関数 `(props) => Node`。`h(Router, ...)` 経由は ComponentFn
    // 型 (props: Record<string, unknown>) と RouterProps の narrowing で TS が
    // 通らないため直接呼ぶ。fine-grained reactive では `h()` か直呼出しかは挙動
    // 同等 (内部で同じ Component(props) を実行する)。
    hydrate(() => Router({ routes, eagerModules }), root);
    // ADR 0060 partial hydration: shell hydrate 完了後に island queue を drain + hook。
    // Router hydrate より後に呼ぶことで、shell hydrate 中に作られた DOM の上に重ねて
    // island marker range を探せる (= shell hydrate が終わる前に呼ぶと marker range の
    // 親 element がまだ未確定で、findMarkerRange が見つからないリスク)。
    setupIslandHydration(eagerModules);
  };

  window.__vidroBoot = fire;
  if (window.__vidroBootPending) {
    // bundle 遅着経路 (= trigger 先着で flag が立っていた)。flag を消してから発火。
    delete window.__vidroBootPending;
    fire();
  } else if (document.readyState === "loading") {
    // bundle 先着 + HTML parse 中。trigger が後で stream で届けば即 fire、
    // 届かないまま parse 完了するケース (network 切断 / dev 経由) は
    // DOMContentLoaded を最終 fallback として boot を起動する。
    document.addEventListener("DOMContentLoaded", fire);
  } else {
    // HTML parse 完了済 + trigger 不在 (= dev で main.tsx が遅延読込されて
    // DOMContentLoaded を逃したケース等)。即発火で fallback。
    fire();
  }
}
