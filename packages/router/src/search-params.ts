// ADR 0052 — searchParams() primitive: URL search 部分を client URL state として扱う。
//
// state ライフサイクル設計:
//   module scope に signals Map (= key → Signal<string|undefined>) を持つ。
//   - client: window.location.search を SoT とし、新 key の初期値は URL から読む。
//     既存 signal の write は subscribe 経由で `history.replaceState` を発火する。
//   - server: _initServerSearch(search) で per-request の initial search を立てる。
//     SSR 終了で _endServerSearchScope() が signals + serverInitialSearch を flush。
//   - popstate / pushState (= URL 外因変化) は _syncSearchParamsFromUrl() で
//     既存 signals の値を URL から書き戻す (suppressUrlWrite で replaceState 抑止)。
//
// path Y (ADR 0052): searchParams 変更で loader 自動再実行は **しない**。
// pagination 等で fresh data が必要なら revalidate() を user 側で explicit に呼ぶ。
//
// public:
//   - searchParams<T>(): URL search を Proxy 経由の reactive store として返す
//   - revalidate(): 現 route の loader を再 fire (Router が mount 中の時のみ動作)
//
// internal (router.tsx / navigation.ts のみ参照):
//   - _initServerSearch(search): SSR 経路で per-request initial search を立てる
//   - _endServerSearchScope(): SSR 終了で signals + serverInitialSearch を flush
//   - _syncSearchParamsFromUrl(): popstate / navigate 後に既存 signals を URL から書き戻し
//   - _registerRevalidator(fn): Router mount 時に登録、unmount で外す

import { signal, type Signal } from "@vidro/core";

// --- module scope state ---

// 既に access された key の signal を保持。同 page 内で複数回 searchParams() 呼んでも
// 同じ Map を共有するため、`sp1.q === sp2.q` (= identity 一致)。
let signals: Map<string, Signal<string | undefined>> = new Map();

// _syncSearchParamsFromUrl 中の signal 更新で subscribe 経由 replaceState が走らない
// ようにするフラグ。URL は既に正しい (popstate / navigate で書き換わった後) ので
// 二重書き込みを抑止する。
let suppressUrlWrite = false;

// SSR 経路で立てる per-request initial search ("?q=Vidro" 等)。client 側は window
// から直接読むため使わない。
let serverInitialSearch: string | null = null;

// Router mount 中に登録される revalidator 関数。client mode の Router がループ
// 開始時に reset() ベースの実装を register する。SSR / Router 未 mount では null
// で revalidate() は no-op。
let _revalidator: (() => Promise<void>) | null = null;

// --- public types ---

/**
 * searchParams() の戻り型。Store<T> を直接使わず -? 修飾子で optional を剥がすのは、
 * runtime 側 Proxy が「declare されてる key も してない key も全部 lazy に Signal を
 * 返す」挙動なので、user 視点でも sp.q が必ず Signal として読める方が DX 高いため。
 */
type SearchParamsStore<T extends Record<string, string | undefined>> = {
  [K in keyof T]-?: Signal<T[K]>;
};

// --- public API ---

/**
 * 現 URL の search 部分を **reactive store** として取得 (ADR 0052)。
 *
 * - default (= generic 省略): 全 key が `Signal<string | undefined>` として lazy access
 *   `sp.q.value` で初めて signal 生成、URL から initial 値を読む
 * - generic 指定: 型 narrow が効く (例: `searchParams<{ sort?: "asc" | "desc" }>()`)
 *   runtime は declare の有無に関わらず全 key を受け付けるが、TS が typo を弾く
 * - write (`sp.q.value = "..."`): URL を `history.replaceState` で同期更新
 *   pushState は `<Link>` / `navigate()` の navigation 責務なので、searchParams write は
 *   ephemeral state として history を汚さない
 * - delete (`sp.q.value = undefined`): URL から該当 param を完全削除
 * - empty (`sp.q.value = ""`): URL に `q=` (empty value) として残す
 * - popstate / navigate: router 側で `_syncSearchParamsFromUrl()` が呼ばれ、既存 signals
 *   の値が URL の最新値に書き戻される
 *
 * Path Y (ADR 0052): searchParams 変更で loader 自動再実行は **しない**。
 * pagination 等で fresh data が必要なら `revalidate()` を user 側で explicit に呼ぶ。
 *
 * 使い方:
 * ```tsx
 * import { searchParams } from "@vidro/router";
 *
 * const sp = searchParams();
 * sp.q.value;     // string | undefined
 * sp.q.value = "Vidro";  // URL 更新 (replaceState)
 *
 * // narrow したい場合
 * const sp2 = searchParams<{ sort?: "asc" | "desc" }>();
 * sp2.sort.value; // "asc" | "desc" | undefined
 * ```
 */
export function searchParams(): SearchParamsStore<Record<string, string | undefined>>;
export function searchParams<T extends Record<string, string | undefined>>(): SearchParamsStore<T>;
export function searchParams<
  T extends Record<string, string | undefined> = Record<string, string | undefined>,
>(): SearchParamsStore<T> {
  // Proxy target は空 object。実体は signals Map 経由で lazy 管理する。
  // 同 page 内で複数回 searchParams() 呼んでも、各呼び出しで作られる Proxy は
  // 別 instance だが get trap が同じ signals Map を見るので signal identity は
  // 共有される (= `sp1.q === sp2.q`)。
  const target = {} as Record<string, Signal<string | undefined>>;
  return new Proxy(target, {
    get(_, key) {
      if (typeof key !== "string") return undefined;
      return getOrCreateSignal(key);
    },
  }) as SearchParamsStore<T>;
}

/**
 * 現 route の loader を再 fire (Path Y、ADR 0052)。Router が mount 時に
 * revalidator を登録、unmount で外す。Router 未 mount (= SSR や test 等) なら
 * Promise.resolve() を返す no-op。
 *
 * 戻り値の Promise は loader 再 fire 完了 (= effect の Promise.all 解決) 時に
 * resolve する。await して fresh data 反映後の処理に繋げられる。
 */
export function revalidate(): Promise<void> {
  if (_revalidator === null) return Promise.resolve();
  return _revalidator();
}

// --- internal API ---

/**
 * @internal SSR 経路で per-request の initial search を立てる。signals Map も
 * クリアして前 request の状態が漏れないようにする。Workers 並行 request の race
 * 対策は AsyncLocalStorage 化で別途扱う (= project_pending_rewrites)。
 */
export function _initServerSearch(search: string): void {
  serverInitialSearch = search;
  signals = new Map();
}

/**
 * @internal SSR 終了で per-request 状態を全部 flush。renderServerSide の
 * try/finally で必ず呼ぶこと。
 */
export function _endServerSearchScope(): void {
  serverInitialSearch = null;
  signals = new Map();
}

/**
 * @internal popstate (戻る/進む) や `<Link>` / `navigate()` 経由の URL 変更後に
 * 呼んで、既存 signals の値を URL の最新値に書き戻す。signal の subscribe 経路は
 * suppressUrlWrite フラグで replaceState 発火を抑止する (= URL は既に正しい)。
 */
export function _syncSearchParamsFromUrl(): void {
  if (typeof window === "undefined") return;
  const newParams = new URLSearchParams(window.location.search);
  suppressUrlWrite = true;
  try {
    for (const [key, sig] of signals) {
      const newValue = newParams.get(key) ?? undefined;
      // peek() で observer 登録回避 (= sync の副次効果で track しない)。
      if (sig.peek() !== newValue) {
        sig.value = newValue;
      }
    }
  } finally {
    suppressUrlWrite = false;
  }
}

/**
 * @internal Router が mount 時に呼んで自身の loader 再 fire 経路を登録。
 * 戻り値は unregister 関数。Router unmount で必ず呼ぶこと。
 */
export function _registerRevalidator(fn: () => Promise<void>): () => void {
  _revalidator = fn;
  return () => {
    if (_revalidator === fn) _revalidator = null;
  };
}

/**
 * @internal test 用 reset。signals + revalidator + serverInitialSearch を全 flush。
 */
export function _resetSearchParamsForTest(): void {
  signals = new Map();
  serverInitialSearch = null;
  _revalidator = null;
  suppressUrlWrite = false;
}

// --- helpers ---

/**
 * SSR 中の serverInitialSearch を最優先、次に client の window.location.search を返す。
 * どちらも無ければ "" (= 一切 query なし)。
 *
 * SSR 中 (= _initServerSearch ↔ _endServerSearchScope の間) は serverInitialSearch を
 * 優先するのが意図的: production の Workers SSR では window が無いため両者が衝突しないが、
 * jsdom test 環境では window が存在するため、SSR セマンティクスを再現するには明示的に
 * 優先付けが必要。client mode (= SSR 経路を通らない) では serverInitialSearch は null で
 * 自然に window へ fallback するので production 動作には影響しない。
 */
function getInitialSearch(): string {
  if (serverInitialSearch !== null) return serverInitialSearch;
  if (typeof window !== "undefined") return window.location.search;
  return "";
}

/**
 * key の signal を取得 (or 初回 access なら作成)。
 * 作成時に signal.subscribe で「変化したら URL を replaceState で書き換える」
 * 副作用を仕掛ける。suppressUrlWrite 中は副作用を skip して URL 二重書き込みを
 * 防ぐ。
 */
function getOrCreateSignal(key: string): Signal<string | undefined> {
  let sig = signals.get(key);
  if (!sig) {
    const params = new URLSearchParams(getInitialSearch());
    const initial = params.get(key) ?? undefined;
    sig = signal(initial);
    sig.subscribe((value) => {
      if (suppressUrlWrite) return;
      if (typeof window === "undefined") return;
      const url = new URL(window.location.href);
      if (value === undefined) {
        url.searchParams.delete(key);
      } else {
        url.searchParams.set(key, value);
      }
      window.history.replaceState({}, "", url);
    });
    signals.set(key, sig);
  }
  return sig;
}
