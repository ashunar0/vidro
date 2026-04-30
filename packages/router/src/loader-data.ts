// ADR 0049 — loaderData() primitive。loader 戻り raw を Store として取得する経路。
//
// router.tsx (foldRouteTree) が leaf / layout を render する直前に
// `_setLayerIndex(i)` で「現在の layer index」を module scope に立てる。user の
// route component から `loaderData<typeof loader>()` を sync に呼ぶと、対応する
// layer の raw が `store()` で wrap され、shared instance として返る。
//
// 同 page (= 同 pathname) での action revalidate では `_diffMergeAllLayers` で
// field-level の id-keyed reconcile を発火、page remount せずに existing store
// instance を更新する。これが ADR 0049 の痛み B (filter / count signal が action
// 後 reset される) の構造的解消経路。
//
// 制約: `loaderData()` は **route component の sync render 中** に呼ばないと
// `currentLayerIndex` が null で throw する。返った Store reference は handler /
// effect 等から自由に触ってよい (= setup phase で 1 度受けて captured ref を回す
// React useState 流儀)。
//
// SSR concurrency: module scope の `pageLoaderRaws` / `pageLoaderStores` は
// Workers の per-isolate 並行 request で共有されるため race のリスクがある
// (currentPathname / currentParams と同じ既知問題)。`_endRenderScope()` で
// reset しているが、AsyncLocalStorage 化は pending_rewrites の宿題。

import { isSignal, store, type Store } from "@vidro/core";

// ---- module scope state ----

// stores は内部用途で型は緩く unknown 配列にしておく (= `Store<unknown>` は条件型
// 展開の都合で union が冗長になり TS が警告を出す)。loaderData() の戻りで
// `Store<Awaited<ReturnType<L>>>` に cast するので user 視点の型は壊れない。
let pageLoaderRaws: unknown[] = [];
let pageLoaderStores: unknown[] = [];
let currentLayerIndex: number | null = null;

// ---- public API ----

// loader を構造的に受ける最低限の制約。`Parameters` で抜き出すので引数 shape は
// 厳しく縛らない。`loader: () => Promise<R>` のような param 無し loader でも OK。
type AnyLoader = (...args: never[]) => unknown;

/**
 * loader 戻りを **reactive store** として取得 (ADR 0049)。
 *
 * - 同 page 内で複数回呼んでも **同じ instance** を返す (= 論点 4 (α))
 * - action 後の loader 再実行は diff merge で current store に反映される
 *   (= 論点 1 (ii))。page は remount せず、page-local signal は維持される
 * - leaf access は `.value` で raw を取り出す signal triad の規約 (ADR 0047)
 *
 * 使い方:
 * ```ts
 * import { loaderData, type PageProps } from "@vidro/router";
 * import type { loader } from "./server";
 *
 * export default function NotesPage({ params }: PageProps<typeof loader>) {
 *   const data = loaderData<typeof loader>();  // sync 呼び出し必須
 *   const filter = signal("");                  // page-local state も生きる
 *
 *   return <For each={data.notes}>{(n) => <li>{`#${n.id.value}: ${n.title.value}`}</li>}</For>;
 * }
 * ```
 */
export function loaderData<L extends AnyLoader>(): Store<Awaited<ReturnType<L>>> {
  if (currentLayerIndex === null) {
    throw new Error(
      "[loaderData] called outside a route render scope. " +
        "Call loaderData() synchronously at the top of your page/layout component.",
    );
  }
  const idx = currentLayerIndex;
  const cached = pageLoaderStores[idx];
  if (cached !== null && cached !== undefined) {
    return cached as Store<Awaited<ReturnType<L>>>;
  }
  const raw = pageLoaderRaws[idx];
  // raw が undefined / null のままだと store(null) が Signal<null> を返してしまい
  // user の `data.notes` access で TypeError になる。loader 不在 layer (= layout
  // で loader を export しない場合等) で loaderData() を呼ぶのは設計上の誤用なので
  // 早期 throw して気付ける形にしておく。
  if (raw === undefined) {
    throw new Error(
      "[loaderData] no loader data for this layer. " +
        "Make sure the route exports a loader from server.ts.",
    );
  }
  // store() は wrap() で raw object を **destructive に** mutate して各 field を
  // Signal / proxy で置換する (store.ts L67 規約)。loader の戻り値が user の
  // server.ts 内で module-scope cache と参照共有されている場合 (= apps/router/notes
  // の `let notes: Note[] = [...]`)、SSR で wrap が走ると次 request の loader 出力に
  // Signal が混入し、JSON.stringify が `{}` を吐く → action revalidate で diff merge
  // が「全 key 削除」と誤認する致命バグが起きる。
  //
  // よって loaderData() は store() に渡す前に deep clone する。clone は JSON 経由
  // (Date / Map / Set / function は失う) — loader の戻りは server → client 間で
  // JSON 経由なのでこの制約は元から成立。Date escape hatch 等は ADR 0050+ 案件。
  const cloned = deepCloneRaw(raw);
  const created = store(cloned) as Store<unknown>;
  pageLoaderStores[idx] = created;
  return created as Store<Awaited<ReturnType<L>>>;
}

/** JSON 経由の deep clone。toy 段階の妥協 — Date / Map / Set 等は loss する。 */
function deepCloneRaw<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// ---- Router internal API ----

/**
 * @internal Router (foldRouteTree) が layer の component を呼ぶ直前に立てる。
 * 戻り値は前の値で、try/finally で `_restoreLayerIndex` に渡す。
 */
export function _setLayerIndex(idx: number): number | null {
  const prev = currentLayerIndex;
  currentLayerIndex = idx;
  return prev;
}

/** @internal `_setLayerIndex` の対。render 終了で必ず呼ぶこと。 */
export function _restoreLayerIndex(prev: number | null): void {
  currentLayerIndex = prev;
}

/**
 * @internal navigation (= 別 pathname への遷移) で page が remount される直前に呼ぶ。
 * 旧 stores は捨てて、新 raws を登録する。stores は lazy 作成 (= 次の `loaderData()`
 * 呼び出しで初期化)。
 */
export function _resetPageLoaderData(raws: unknown[]): void {
  pageLoaderRaws = raws.slice();
  pageLoaderStores = raws.map(() => null);
}

/**
 * @internal action 後の loader 再実行で current page を更新。
 * - 既に store 化されている layer は **diff merge** で in-place 更新 (page 維持)
 * - まだ store 化されていない layer は raw だけ差し替え (次回 loaderData() で wrap)
 */
export function _diffMergeAllLayers(newRaws: unknown[]): void {
  for (let i = 0; i < newRaws.length; i++) {
    const newRaw = newRaws[i];
    pageLoaderRaws[i] = newRaw;
    const existing = pageLoaderStores[i];
    if (existing !== null && existing !== undefined) {
      diffMergeIntoStore(existing as unknown, newRaw);
    }
  }
}

/**
 * @internal SSR / 想定外パスでの safety net。サーバ render 終了時に reset して
 * Workers 並行 request の漏洩を最小化する (toy 段階の妥協、AsyncLocalStorage 化は
 * project_pending_rewrites)。
 */
export function _resetAllForServer(): void {
  pageLoaderRaws = [];
  pageLoaderStores = [];
  currentLayerIndex = null;
}

// ---- diff merge implementation ----

/**
 * target (= 既存 store proxy / Signal) に source (= 新 raw) を当てる。type case 分岐:
 *   - target が Signal: `.value = source` で primitive 更新
 *   - target / source が array: `diffMergeArray` (id-keyed or index-based)
 *   - target / source が object: `diffMergeObject` (per-key 再帰)
 *   - 型不一致 (= server 側で field の型が変わった等): caller 側で `target[k] = sv`
 *     経由の置換にフォールバックする (本関数は throw しない)
 */
function diffMergeIntoStore(target: unknown, source: unknown): void {
  if (isSignal(target)) {
    // Signal は primitive 用 wrapper。source が primitive なら .value 更新。
    // source が object/array でも .value 経由で「どんな値も入る」設計 (toy 妥協)。
    (target as { value: unknown }).value = source;
    return;
  }
  if (Array.isArray(target) && Array.isArray(source)) {
    diffMergeArray(target as unknown[], source);
    return;
  }
  if (
    target !== null &&
    typeof target === "object" &&
    source !== null &&
    typeof source === "object" &&
    !Array.isArray(source)
  ) {
    diffMergeObject(target as Record<string, unknown>, source as Record<string, unknown>);
    return;
  }
  // 型不一致 (target が object proxy だけど source が primitive 等)。本関数は内部 helper で
  // top-level のみ呼ばれる (= page loader data の root)。root の型変化はそもそも稀で、
  // 起きたら全置換しかないが proxy root を replace する経路は無い (= 別 ADR 案件)。
  // ここで silently no-op して既存 store を保つ方が runtime 安全。
}

/**
 * object 同士の per-key 再帰 merge。
 * - source にあるが target に無い key → 追加 (proxy set 経由で wrap)
 * - 両方にある key → 値が container (object/array) なら再帰、leaf なら proxy 経由で
 *   set (= 既存 Signal は `.value` 更新、型不一致は新 wrap で置換)
 * - target にあるが source に無い key → 削除 (proxy delete 経由)
 */
function diffMergeObject(target: Record<string, unknown>, source: Record<string, unknown>): void {
  const sourceKeys = new Set(Object.keys(source));
  for (const k of sourceKeys) {
    const sv = source[k];
    const tv = (target as Record<string, unknown>)[k];
    if (k in target && isContainerStore(tv) && isPlainContainer(sv)) {
      // 両方が container shape 一致 → in-place merge
      if (Array.isArray(tv) === Array.isArray(sv)) {
        diffMergeIntoStore(tv, sv);
        continue;
      }
    }
    // それ以外 (新規 key / 型不一致 / leaf): proxy set に委譲
    target[k] = sv;
  }
  for (const k of Object.keys(target)) {
    if (!sourceKeys.has(k)) {
      delete target[k];
    }
  }
}

/**
 * array 同士の merge。
 * - 両方の要素が `id` field を持つ場合 → id-keyed reconcile (id 一致で update、
 *   新 id は追加、消えた id は除去、順序は source に従う)
 * - それ以外 → index-based merge (length 揃え + 各 index で再帰)
 *
 * id 衝突 (= 楽観更新で `crypto.randomUUID()` 等で append した row が server 戻りで
 * 別 id を貰う) は dogfood で痛みが出たら γ (declarative 楽観更新) で別 ADR 起票。
 */
function diffMergeArray(target: unknown[], source: unknown[]): void {
  if (canIdKeyReconcile(target, source)) {
    diffMergeArrayByIds(target, source);
  } else {
    diffMergeArrayByIndex(target, source);
  }
}

/**
 * source の全要素が `id` field を持っていれば id-keyed reconcile 可能。target が
 * 空でも source 形式に従って reconcile する (= 旧 0 件 → 新 N 件もスムーズ)。
 */
function canIdKeyReconcile(target: unknown[], source: unknown[]): boolean {
  if (source.length === 0) return false; // 空なら index-based の length=0 で truncate
  for (const s of source) {
    if (s === null || typeof s !== "object" || !("id" in (s as object))) return false;
  }
  for (const t of target) {
    if (t === null || typeof t !== "object" || !("id" in (t as object))) return false;
  }
  return true;
}

function diffMergeArrayByIds(target: unknown[], source: unknown[]): void {
  // target の id → element proxy のマップ。id は Signal 経由か raw かで両対応する。
  const targetById = new Map<unknown, unknown>();
  for (const t of target) {
    const id = readIdValue(t);
    targetById.set(id, t);
  }

  // source 順に新 array を組む。id 一致で見つかった既存 proxy は in-place merge して再利用、
  // 見つからない id は raw のまま置いておけば splice の wrap で wrap される。
  const next: unknown[] = [];
  for (const s of source) {
    const sid = (s as Record<string, unknown>).id;
    const existing = targetById.get(sid);
    if (existing !== undefined) {
      diffMergeIntoStore(existing, s);
      next.push(existing);
    } else {
      next.push(s);
    }
  }

  // splice で一括置換。array proxy の splice wrapper が新規要素のみ wrap、既存
  // proxy (STORE_RAW marker 付き) は wrap pass-through で identity 維持。length
  // signal の notify は splice 内で 1 回 fire する。
  // biome-ignore lint/suspicious/noExplicitAny: splice 引数の variadic で any spread が要る
  (target.splice as (s: number, c: number, ...i: unknown[]) => unknown)(0, target.length, ...next);
}

function diffMergeArrayByIndex(target: unknown[], source: unknown[]): void {
  const len = source.length;
  for (let i = 0; i < len; i++) {
    if (i < target.length) {
      const tv = target[i];
      const sv = source[i];
      if (isContainerStore(tv) && isPlainContainer(sv) && Array.isArray(tv) === Array.isArray(sv)) {
        diffMergeIntoStore(tv, sv);
      } else {
        target[i] = sv;
      }
    } else {
      // index 越え → push (proxy wrap)
      target.push(source[i]);
    }
  }
  if (target.length > len) {
    target.length = len; // proxy 経由で truncate
  }
}

/** target[i].id を読んで Signal なら .value、生 primitive ならそのまま返す。 */
function readIdValue(elem: unknown): unknown {
  if (elem === null || typeof elem !== "object") return undefined;
  const id = (elem as Record<string, unknown>).id;
  if (isSignal(id)) return (id as { value: unknown }).value;
  return id;
}

/** target[k] が「container (= 中間 proxy)」かどうか。Signal は false。 */
function isContainerStore(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  if (isSignal(value)) return false;
  return true; // 残りは array proxy か object proxy
}

/** source[k] が「container shape (= primitive ではない object/array)」かどうか。 */
function isPlainContainer(value: unknown): boolean {
  return value !== null && typeof value === "object";
}
