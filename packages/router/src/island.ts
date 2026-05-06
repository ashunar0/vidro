// ADR 0060 partial hydration — client side island hydrate runtime。
//
// 役割: SSR で server が emit した island registry (= `__vidroIslandHydrate` queue) を
// walk して、各 island を marker range 内で hydrate する。
//
// 流れ:
//   1. boot() 時に渡された eagerModules から全 `.server.tsx` の stub `__islands` を
//      集めて global island map を作る (= name lookup table)。同 name の collision は
//      Phase 2 では console.warn で last-write-wins (= 衝突を踏んだら別 ADR で path-based
//      lookup に切り替え)
//   2. `__vidroIslandHydrate` の既存 entry を順に hydrate
//   3. 後着 entry のため、queue の `push` を hook して以降の push も即時 hydrate に流す
//      (= shell hydrate より遅れて到着する script tag からの push に対応)
//
// hydrate 自体は core の `hydrateRange(fn, range)` (= ADR 0035 boundary 単位 hydrate と
// 同じ機構) で行う。range = `<!--vi-${key}-start:{json}-->` から `<!--vi-${key}-end-->` の間。
//
// 注意:
//   - eagerModules 内には routes の `.server.tsx` (stub) も含まれる前提 (= boot() の
//     `import.meta.glob('./routes/**\/*.{ts,tsx}', { eager: true })` で glob される範囲)
//   - server 側 `__VidroIsland` の registry push script は document body に挿入されるが、
//     stream の都合で hydrate runtime より遅く到着するケースもあるので queue.push 経由の
//     後着対応が必要

import { h, hydrateRange } from "@vidro/core";

declare global {
  interface Window {
    __vidroIslandHydrate?: IslandQueue;
  }
}

type IslandEntry = {
  key: string;
  name: string;
  seq: number;
};

// queue は配列だが push を hook するため、Window 上では Array 互換 with push override の形。
type IslandQueue = IslandEntry[];

type ComponentFn = (props: Record<string, unknown>) => Node;

/**
 * boot 経路から呼ばれる setup。eagerModules を walk して island name → component の
 * global map を作り、`__vidroIslandHydrate` queue を drain + hook する。
 *
 * 冪等: 同 page で 2 度呼ばれた場合、2 回目は既存 hook を尊重して何もしない (= guard)。
 * navigation で呼び直すケースは想定外 (= 1 page lifecycle で 1 回のみ)。
 */
export function setupIslandHydration(eagerModules: Record<string, unknown>): void {
  if (typeof window === "undefined") return;

  // SSR 経由でしか走らない経路 (= server marker が無いと意味なし)。boot() 時点で
  // 必ず呼ばれる前提だが、defensive に early return。
  const queue: IslandQueue = window.__vidroIslandHydrate ?? (window.__vidroIslandHydrate = []);

  // 同 page で 2 度 setup されないようにする guard。push 関数に flag を立てて判定。
  const queueWithFlag = queue as IslandQueue & { __vidroHooked?: true };
  if (queueWithFlag.__vidroHooked) return;
  queueWithFlag.__vidroHooked = true;

  const islandMap = buildIslandMap(eagerModules);

  // 既存 entry を drain して即時 hydrate (= shell hydrate より早く到着していた entry)
  const existing = queue.splice(0, queue.length);
  for (const entry of existing) hydrateEntry(entry, islandMap);

  // 後着 entry: push を hook して以降の push を即時 hydrate に流す
  const origPush = queue.push.bind(queue);
  queue.push = (...items: IslandEntry[]) => {
    for (const item of items) hydrateEntry(item, islandMap);
    // queue 自体には残さない (= 即時消費されてる)。length は origPush の return が
    // 返した値ではなく現在 length を返すのが Array.push contract。
    return queue.length;
  };
  // origPush 参照を捨てないでおく (= debug で push 経路を直接呼びたい場合に使う、
  // 通常 path では未使用)
  void origPush;
}

// eagerModules から全 .server.tsx stub の __islands を集めて global lookup map を作る。
// stub virtual module は server-component plugin (ADR 0060 Phase 1) が
//   `export const __islands: Record<string, unknown> = { Counter, LikeButton };`
// の形で吐く。
function buildIslandMap(eagerModules: Record<string, unknown>): Record<string, ComponentFn> {
  const map: Record<string, ComponentFn> = {};
  for (const [path, mod] of Object.entries(eagerModules)) {
    if (!path.endsWith(".server.tsx")) continue;
    const islands = (mod as { __islands?: Record<string, unknown> }).__islands;
    if (!islands) continue;
    for (const [name, comp] of Object.entries(islands)) {
      if (typeof comp !== "function") continue;
      if (map[name]) {
        // Phase 2 では衝突を console.warn + last-write-wins。実プロジェクトで衝突を
        // 踏んだら別 ADR で path-based lookup に切り替え (= entry に routeFile を含める形)。
        //
        // 注意: Object.entries の順序は Vite の transform 順依存で OS 由来の非決定性が
        // ある (= reviewer W-2)。衝突 page を作った時点で「どちらが採用されるか不定」と
        // user に伝える形になる。固定したい場合は Object.entries(eagerModules).sort() で
        // 安定化する手もあるが、衝突自体を避けるべきなので Phase 2 では warn のまま。
        console.warn(
          `[vidro] island name collision for '${name}' (last seen in ${path}). ` +
            `Hydration will use the last definition; consider renaming.`,
        );
      }
      map[name] = comp as ComponentFn;
    }
  }
  return map;
}

function hydrateEntry(entry: IslandEntry, islandMap: Record<string, ComponentFn>): void {
  const Component = islandMap[entry.name];
  if (!Component) {
    console.warn(
      `[vidro] island '${entry.name}' not found in eager modules (key: ${entry.key}). ` +
        `Make sure the island file is reachable via the boot() glob pattern.`,
    );
    return;
  }

  const range = findMarkerRange(entry.key);
  if (!range) {
    console.warn(
      `[vidro] marker range '${entry.key}' not found in DOM. ` +
        `Server may have skipped emit, or markers were stripped by HTML transform.`,
    );
    return;
  }

  let props: Record<string, unknown>;
  try {
    props = JSON.parse(extractPropsJSON(range.start));
  } catch (err) {
    console.error(
      `[vidro] failed to parse props for '${entry.key}': ` +
        (err instanceof Error ? err.message : String(err)),
    );
    return;
  }

  // hydrateRange 内で Component(props) を評価 = post-order cursor で marker range
  // 内の DOM を消費して effect / event listener を attach する。
  // h(Component, props) を thunk で渡すのは、core の hydrate API が `() => Node` 受け取り
  // のため (= Component 関数を直渡しすると root Owner と引数渡しの整合がとれない)。
  hydrateRange(() => h(Component, props), range);
}

// document.body 全体を NodeIterator で walk して、`vi-${key}-start:` で始まる comment と
// `vi-${key}-end` の comment を探す。一致するペアを返す。
function findMarkerRange(key: string): { start: Comment; end: Comment } | null {
  if (typeof document === "undefined") return null;
  const iter = document.createNodeIterator(document.body, NodeFilter.SHOW_COMMENT);
  let start: Comment | null = null;
  let end: Comment | null = null;
  let n: Node | null;
  while ((n = iter.nextNode())) {
    const value = (n as Comment).nodeValue ?? "";
    if (!start && value.startsWith(`${key}-start:`)) start = n as Comment;
    else if (start && value === `${key}-end`) {
      end = n as Comment;
      break;
    }
  }
  return start && end ? { start, end } : null;
}

// `vi-Counter-1-start:{"initial":0}` から `{"initial":0}` 部分を取り出す。
// `:` の最初の出現で split (= JSON 内の `:` には影響されない、prefix だけ取り除く)。
//
// 前提: marker key prefix (`vi-${name}-${seq}-start`) には `:` が含まれない。
//   - name は JSX identifier (`[A-Za-z0-9_$]+`) — `:` は文法上不可
//   - seq は数値、`-start` リテラルも `:` なし
// → 最初の `:` は必ず props JSON の区切り (= reviewer W-1 文書化補足)。
function extractPropsJSON(start: Comment): string {
  const value = start.nodeValue ?? "";
  const colonIdx = value.indexOf(":");
  return colonIdx >= 0 ? value.slice(colonIdx + 1) : "{}";
}
