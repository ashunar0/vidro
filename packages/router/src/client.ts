import { hydrate } from "@vidro/core";
import { Router } from "./router";
import type { RouteRecord } from "./route-tree";
import { setupIslandHydration } from "./island";

/**
 * server function の 422 (= ADR 0073 で `serverFn({ validator: { params, data } })`
 * slot が parse 失敗時に投げる Response、または user 自身が手動で同 shape の
 * 422 Response を throw した場合) を client side で受け取って throw する custom
 * error class (ADR 0073、旧 ADR 0071 + ADR 0072 supersede)。
 *
 * wire shape (= ADR 0059): `{ fields: Record<string, string>, slot?: "params" | "data" }`、
 * 422 + content-type application/json の場合に deserialize される。
 *
 * 使い方 (= post-form.tsx 等の island form):
 *
 *   import { ServerFnValidationError } from "@vidro/router/client";
 *   import { createPost } from "./server";
 *
 *   try {
 *     const result = await createPost({ data });
 *     // success path
 *   } catch (err) {
 *     if (err instanceof ServerFnValidationError) {
 *       formControl.setFieldErrors(err.fields);
 *     } else {
 *       throw err; // 想定外
 *     }
 *   }
 */
export class ServerFnValidationError extends Error {
  /** stub の URL template (= 例: "/posts/new/createPost") */
  readonly url: string;
  /**
   * field 別 error message (= ADR 0059 規約)。`Record<string, string>` で
   * field name → message。1 field 1 message 制約 (= ADR 0059 / ADR 0071 §論点 3 同形)。
   */
  readonly fields: Readonly<Record<string, string>>;

  constructor(url: string, fields: Record<string, string>) {
    super(`[vidro] validation failed for ${url}: ${Object.keys(fields).join(", ")}`);
    this.name = "ServerFnValidationError";
    this.url = url;
    this.fields = fields;
  }
}

// ADR 0073: bundler が生成する client side stub の runtime 部品。
//
// server.ts / *.server.tsx 内の `serverFn({ ... })` named export は、client
// bundle pass で `__vidroServerFnStub("/url-template")` 呼び出しに置換される
// (= plugin 側 transformServerFnSourceForClient)。本 helper は URL template の
// `[xxx]` 動的 segment を `input.params[xxx]` で置換、`{ params, data }` を
// JSON object として body に詰めて POST 1 回 → JSON parse する thin wrapper。
//
// URL template の `[xxx]` segment は file path 由来 (= ADR 0067 + ADR 0073、
// `routes/posts/[slug]/edit/server.ts` → `/posts/[slug]/edit/updatePost`)。
// `input.params.slug` の値で `[slug]` を置換、`input.data` は body にそのまま流す。
//
// 旧 wire (= ADR 0070、JSON array body + positional args) との incompat:
//   - body は **JSON array → JSON object** (`{ params?, data? }`)
//   - public form の signature は **可変長引数 → input 1 個** (`(input?: {...})`)
//   - URL `[xxx]` の値取り元は **args[i] → input.params[xxx]** (key で直接引く)
//
// design notes:
//   - 戻り値は content-type で判定: application/json なら res.json()、
//     204 No Content なら undefined、それ以外は text として返す
//   - error は res.ok === false なら throw、status + body の詳細は ServerFnError
//     等の専用 class 化を Open Question として保留 (ADR 0073 Q3)
//   - middleware が早期 return した Response は普通に !ok or 4xx として降りてくる
//     (= Phase 1 の throw earlyResponse は server entry が catch → wire に流す)
//   - `input` 全体省略可 (= no params / no data の serverFn 呼出)、内部 `{}` 扱い

/** stub に渡す入力 object (= ADR 0073 採用 form)、両 slot とも optional。 */
export type ServerFnStubInput = {
  readonly params?: Record<string, unknown>;
  readonly data?: unknown;
};

/**
 * bundler 生成 stub の runtime 実体。`urlTemplate` は file path 由来の URL
 * (= 例: `/posts/[slug]/edit/updatePost`) を受け取り、`input.params` で `[xxx]`
 * を埋めて `{ params, data }` を POST + JSON wire する関数を返す。
 *
 * 通常 user は直接呼ばない (= bundler が `import { fn } from "./server"` を
 * `__vidroServerFnStub("/url")` 呼び出しに置換する経路で使われる)。
 */
export function __vidroServerFnStub(
  urlTemplate: string,
): (input?: ServerFnStubInput) => Promise<unknown> {
  return async (input?: ServerFnStubInput): Promise<unknown> => {
    const params = input?.params;
    // [xxx] segment を `input.params[xxx]` で置換。null / undefined / object は
    // 不正値として throw (= 空文字 fallback は `/posts//edit/...` を生んで silent
    // に 404 化する debug 困難パターン、object は `[object Object]` URL になる)。
    // user の引数誤りを早く可視化することを優先 (= 想定外を生やさない)。
    const url = urlTemplate.replace(/\[(\w+)\]/g, (_match, name: string) => {
      const v = params?.[name];
      if (v === null || v === undefined) {
        throw new Error(
          `[vidro] server function ${urlTemplate}: dynamic segment "${name}" is ${
            v === null ? "null" : "undefined"
          }, expected string|number|boolean|bigint in input.params.${name}.`,
        );
      }
      const tv = typeof v;
      if (tv === "string") return encodeURIComponent(v as string);
      if (tv === "number" || tv === "boolean" || tv === "bigint") {
        return encodeURIComponent(String(v));
      }
      throw new Error(
        `[vidro] server function ${urlTemplate}: dynamic segment "${name}" expects ` +
          `string|number|boolean|bigint in input.params.${name}, got ${tv}.`,
      );
    });
    // body wire = `{ params, data }` JSON object (ADR 0073)。両 slot とも省略可、
    // server 側 dispatchServerFn は URL params を URL = source of truth として優先、
    // body の params はそのまま merge される (= 通常 stub は URL 側に値を埋めるが
    // body にも params を入れて double safety にしておく)。
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ params: input?.params, data: input?.data }),
    });
    if (!res.ok) {
      // 422 + content-type application/json + body shape が `{fields: ...}` なら
      // ServerFnValidationError として deserialize (= ADR 0071 + ADR 0072 連動、
      // validator middleware の 422 throw を user に typed error として届ける経路)。
      // shape が想定外 (= 422 だが {fields} 構造でない) なら plain Error に fall through。
      if (
        res.status === 422 &&
        (res.headers.get("content-type") ?? "").includes("application/json")
      ) {
        const data = (await res.json().catch(() => null)) as unknown;
        if (
          typeof data === "object" &&
          data !== null &&
          "fields" in data &&
          typeof (data as { fields: unknown }).fields === "object" &&
          (data as { fields: unknown }).fields !== null
        ) {
          throw new ServerFnValidationError(
            urlTemplate,
            (data as { fields: Record<string, string> }).fields,
          );
        }
        // shape 不一致 → fall through に進むため status だけ stub の Error に詰める
        throw new Error(
          `[vidro] server function ${urlTemplate} failed: 422 (validation error shape mismatch)`,
        );
      }
      // body が読めれば message として混ぜる、駄目なら status 番号だけで例外。
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
