// `<script type="application/json" id="__vidro_data">` を 1 回だけ parse して
// module cache に保持する shared reader (ADR 0030、B-5c 3b-α)。
//
// 動機: Router (`@vidro/router`) と Resource (`@vidro/core`) が両方とも
// `__vidro_data` を読みたい (Router は `pathname / params / layers`、Resource は
// `resources` field)。各々独立に `getElementById + remove` するとライフサイクル
// 衝突 (どちらが先に remove するかで他方が読めなくなる)。本 module で 1 回だけ
// read + remove + cache、両者は cache から自由に field を取り出す形にする。
//
// 順序非依存: どの module が最初に readVidroData() を呼んでも、cache 経由で
// 同じ JSON を共有する。
//
// streaming SSR (ADR 0034): `window.__vidroResources` から resources を merge
// する。streaming chunk の `__vidroAddResources` は DOM textContent ではなく
// window object に貯めるよう変更したので (ADR 0033 review fix Issue 1)、
// `<script id="__vidro_data">` の el.remove() lifecycle と独立に accumulate
// される。cache 確定後に届いた chunk も window object には残る (将来段階
// hydration 化時の late-arriving lookup の足場)。

let cache: Record<string, unknown> | null | undefined = undefined;

/**
 * `__vidro_data` JSON を返す。初回呼び出しで `getElementById + JSON.parse + remove
 * + cache`、以降は cache から返す。SSR 経由の navigation でない (script tag 自体
 * 無い、parse 失敗等) 場合は null。
 *
 * `window.__vidroResources` (streaming SSR の partial patch、ADR 0034) があれば
 * `parsed.resources` に shallow merge してから cache 確定。`<script id="__vidro_data">`
 * 自体に resources が無い navigation でも、streaming 経由で resources が乗ったら
 * `parsed.resources` を作って入れる。
 */
export function readVidroData(): Record<string, unknown> | null {
  if (cache !== undefined) return cache;
  if (typeof document === "undefined") {
    cache = null;
    return null;
  }
  const el = document.getElementById("__vidro_data");
  if (!el || !el.textContent) {
    cache = null;
    return null;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(el.textContent) as Record<string, unknown>;
  } catch {
    el.remove();
    cache = null;
    return null;
  }
  el.remove();
  // ADR 0034: streaming SSR の per-boundary partial patch (`__vidroAddResources`)
  // は window object に貯まる。ここで shallow merge して cache に閉じ込める。
  const streamResources = (globalThis as { __vidroResources?: Record<string, unknown> })
    .__vidroResources;
  if (streamResources) {
    const existing = (parsed.resources as Record<string, unknown> | undefined) ?? {};
    parsed.resources = { ...existing, ...streamResources };
  }
  cache = parsed;
  return parsed;
}

/**
 * test 用の cache reset。`__` prefix は internal API である表明。production code
 * からは呼ばない。
 */
export function __resetVidroDataCache(): void {
  cache = undefined;
}
