// renderToString(fn): string — JSX を server renderer で評価して HTML string に焼く。
// ADR 0016 Step B-2a で導入。
//
// 流れ:
//   1. 現 renderer を退避 → serverRenderer に差し替え
//   2. 独立した root Owner を立て、runWithMountScope で fn を評価
//   3. 評価中に作られる effect は isServer 分岐で body 1 回実行 + 即 dispose
//   4. onMount は queue に積まれるが flushMountQueue を呼ばないので走らない
//   5. 結果の VNode tree を serialize → HTML string
//   6. owner.dispose で evaluate 中に残ったリソースを解放、renderer を defensive reset
//
// renderToStringAsync(fn): Promise<{html, resources}> — ADR 0030 Step B-5c で追加。
// `bootstrapKey` 付き createResource を server で resolve してから markup を作る
// 2-pass async 版。詳細は関数 doc。

import { setRenderer, getRenderer, type Renderer } from "./renderer";
import { runWithMountScope, discardMountQueue } from "./mount-queue";
import { Owner } from "./owner";
import { serverRenderer, serialize, type VNode } from "./server-renderer";
import {
  ResourceScope,
  runWithResourceScope,
  type BootstrapValue,
  type SerializedError,
} from "./resource-scope";

export function renderToString(fn: () => Node): string {
  const previous = getRenderer();
  // serverRenderer は VNode を返すので、Renderer<Node, Element, Text> に cast して
  // module state に載せる (ADR 0016 の「universal 境界コスト」で許容)。
  setRenderer(serverRenderer as unknown as Renderer<Node, Element, Text>);
  const owner = new Owner(null);
  try {
    const root = runWithMountScope(() => owner.run(fn));
    // root は VNode だが戻り型が Node のまま (jsx.ts の h が Node で返す)。
    // cast で server 側形式として扱う。
    return serialize(root as unknown as VNode);
  } finally {
    // server では onMount を発火しないので、溜まった queue を明示的に捨てる。
    // 放置すると次の renderToString で残り物が見えてしまう。
    discardMountQueue();
    owner.dispose();
    setRenderer(previous);
  }
}

/** renderToStringAsync の戻り値。`__vidro_data.resources` に同居させる前提。 */
export type RenderToStringAsyncResult = {
  /** 2-pass で resolved 値が焼かれた HTML markup */
  html: string;
  /** bootstrapKey → BootstrapValue の plain object (JSON.stringify に直接渡せる形) */
  resources: Record<string, BootstrapValue>;
};

/**
 * server で `bootstrapKey` 付き createResource を resolve してから markup を作る
 * 2-pass async 版 (ADR 0030 Step B-5c)。
 *
 *   1-pass: 空 ResourceScope で renderToString → Resource constructor が
 *           server mode を検知して fetcher を scope に register、loading=true
 *           で markup (この markup は捨てる)
 *   resolve: scope.fetchers を Promise.allSettled で待ち、resolved/rejected を
 *           BootstrapValue に整形。reject は SerializedError 形式に変換 (router の
 *           serializeError と同形、5-a)
 *   2-pass: resolved hits 入りの ResourceScope で renderToString → Resource
 *           constructor が hit を引き当てて loading=false スタート、resolved 値で
 *           markup が完成
 *
 * caller (createServerHandler 等) は返ってきた `resources` を `__vidro_data` に
 * 同居させる。client 側 Resource constructor が initial value を引き当てるので
 * blink 解消。
 *
 * `bootstrapKey` 未指定の resource は scope に register されない (B-5b 動作と同じ
 * loading=true 状態で markup に焼かれる)。
 *
 * CPU コストは 2x (JSX 評価 + VNode build を 2 回)。1-pass + 穴埋め化は将来の
 * 最適化案件 (project_pending_rewrites)。
 */
export async function renderToStringAsync(fn: () => Node): Promise<RenderToStringAsyncResult> {
  // --- 1-pass: fetcher 集め ---
  const collectScope = new ResourceScope();
  runWithResourceScope(collectScope, () => {
    // markup 結果は捨てる。意義は scope.fetchers 集めること。
    renderToString(fn);
  });

  // --- resolve all ---
  // Map → entries 配列に固定。Promise.allSettled の結果と添字対応するため。
  const entries = Array.from(collectScope.fetchers.entries());
  const settled = await Promise.allSettled(entries.map(([, fetcher]) => fetcher()));

  const hits = new Map<string, BootstrapValue>();
  for (let i = 0; i < entries.length; i++) {
    const key = entries[i]![0];
    const result = settled[i]!;
    if (result.status === "fulfilled") {
      hits.set(key, { data: result.value });
    } else {
      hits.set(key, { error: serializeBootstrapError(result.reason) });
    }
  }

  // --- 2-pass: resolved 値で markup ---
  const renderScope = new ResourceScope(hits);
  let html = "";
  runWithResourceScope(renderScope, () => {
    html = renderToString(fn);
  });

  // hits Map を JSON serializable な plain object に変換
  const resources: Record<string, BootstrapValue> = {};
  for (const [k, v] of hits) resources[k] = v;

  return { html, resources };
}

/** Promise.allSettled の reject reason を SerializedError 形式に整形。 */
function serializeBootstrapError(reason: unknown): SerializedError {
  if (reason instanceof Error) {
    return { name: reason.name, message: reason.message, stack: reason.stack };
  }
  return { name: "Error", message: String(reason) };
}
