// @vidro/hibana/client — client-side runtime (island hydration + navigation)。
//
// browser に load される bundle 用 entry。提供する setup 関数:
//   - setupIslandHydration(islandMap): island registry queue を drain & hook
//   - setupNavigation(): <Link> click intercept + HTML swap navigation (= ADR 0080)
//
// server (= __VidroIsland) が emit した island registry queue (= `window.__vidroIslandHydrate`)
// を drain & hook して、各 island を marker range 内で hydrate する。
//
// 流れ:
//   1. app の client.ts (= browser bundle entry) が setupIslandHydration({Counter}) を呼ぶ
//   2. queue を drain、各 entry を hydrateEntry へ
//   3. queue.push を hook、後着 entry (= streaming で遅れて到着する script 由来) も即時 hydrate
//
// 合流ポイント: @vidro/router/island.ts の setupIslandHydration と同じ marker protocol を
// 共有する (= vi-${name}-${seq}-start:{json} / vi-${name}-${seq}-end の comment)。Vidro 側は
// eagerModules 経由で islandMap を build する Vidro 特有の glob pattern を使うが、Hibana は
// 直接 flat map を受け取る点だけ違う。将来 @vidro/core に "island runtime contract" として
// 抽出する候補 (= memory project_hibana_vidro_interaction の合流ポイント #2)。

import { h, hydrateRange } from "@vidro/core";

// ADR 0080: Step 5 (HTML swap navigation) の client runtime を re-export
export { setupNavigation } from "./client-navigation.js";

type IslandEntry = { key: string; name: string; seq: number };

// public 用 island 型: user 側が `(props: {initial: number}) => Node` 等で typed component を
// 渡してくる。function parameter contravariance を回避するため `any` で受ける (= 内部で
// 動的 props を渡す前提、boundary で 1 度だけ cast)。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type IslandComponent = (props: any) => Node;
// 内部 cast 用の strict 型: hydrateRange に渡す時のみ使う。
type ComponentFn = (props: Record<string, unknown>) => Node;

declare global {
  interface Window {
    __vidroIslandHydrate?: IslandEntry[];
  }
}

/**
 * island hydration の setup。app の client.ts entry から 1 回呼ぶ。冪等: 2 度目以降は no-op。
 *
 * @param islandMap island name → component function の lookup table。
 *   user は `{ Counter, LikeButton, ... }` の形で渡す (= import した default export を集めて object に)。
 */
export function setupIslandHydration(islandMap: Record<string, IslandComponent>): void {
  if (typeof window === "undefined") return;

  const queue: IslandEntry[] = window.__vidroIslandHydrate ?? (window.__vidroIslandHydrate = []);

  // 2 度 setup されないようにする guard。queue object に flag を立てて判定。
  const queueWithFlag = queue as IslandEntry[] & { __hibanaHooked?: true };
  if (queueWithFlag.__hibanaHooked) return;
  queueWithFlag.__hibanaHooked = true;

  // 既存 entry を drain して即時 hydrate (= shell より早く到着していた script 由来)
  const existing = queue.splice(0, queue.length);
  for (const entry of existing) hydrateEntry(entry, islandMap);

  // 後着 entry: push を hook して以降の push も即時 hydrate に流す
  queue.push = (...items: IslandEntry[]) => {
    for (const item of items) hydrateEntry(item, islandMap);
    return queue.length;
  };
}

function hydrateEntry(entry: IslandEntry, islandMap: Record<string, IslandComponent>): void {
  const Component = islandMap[entry.name] as ComponentFn | undefined;
  if (!Component) {
    console.warn(
      `[hibana] island '${entry.name}' not found in registry (key: ${entry.key}). ` +
        `client.ts の setupIslandHydration に該当 component を渡してる?`,
    );
    return;
  }

  const range = findMarkerRange(entry.key);
  if (!range) {
    console.warn(
      `[hibana] marker range '${entry.key}' not found in DOM. ` +
        `server が marker emit した? HTML transform で comment が剥がされた?`,
    );
    return;
  }

  let props: Record<string, unknown>;
  try {
    props = JSON.parse(extractPropsJSON(range.start));
  } catch (err) {
    console.error(
      `[hibana] failed to parse props for '${entry.key}': ` +
        (err instanceof Error ? err.message : String(err)),
    );
    return;
  }

  // h(Component, props) を thunk で渡す: core の hydrateRange API が () => Node 受け取り。
  hydrateRange(() => h(Component as never, props as never) as Node, range);
}

// document.body 全体を NodeIterator で walk して、`vi-${key}-start:` で始まる comment と
// `vi-${key}-end` の comment を探す。一致するペアを返す。Vidro 側 router/island.ts の
// findMarkerRange と完全同じ protocol (= shared kernel candidate)。
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
// 最初の `:` で split (= marker key prefix に `:` は出現しない契約)。
function extractPropsJSON(start: Comment): string {
  const value = start.nodeValue ?? "";
  const colonIdx = value.indexOf(":");
  return colonIdx >= 0 ? value.slice(colonIdx + 1) : "{}";
}
