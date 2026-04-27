import { Signal } from "./signal";
import { batch } from "./batch";
import { getCurrentSuspense, type SuspenseScope } from "./suspense-scope";
import { getRenderer } from "./renderer";
import { readVidroData } from "./bootstrap";
import {
  getCurrentResourceScope,
  type BootstrapValue,
  type SerializedError,
} from "./resource-scope";

/**
 * 非同期 fetcher の結果を 3 axis (data / loading / error) で reactive に公開する
 * primitive。Solid の `createResource` 相当だが、Vidro は class instance + `.value`
 * の signal 統一感に揃える (ADR 0006 / 0028)。
 *
 * 利用側は effect / JSX 内で `r.value` / `r.loading` / `r.error` を読むと、
 * fetcher の resolve / reject に応じて自動再描画される。`refetch()` で再実行可能。
 *
 * race condition は内部 token 方式で対策: 古い fetch が遅延 resolve しても、
 * 最新 token と一致しないので state に反映されない。
 *
 * Suspense 連携 (ADR 0029、B-5b): constructor 時に nearest SuspenseScope を捕捉し、
 * pending 中は scope の count に register する。Suspense より **外** で構築された
 * resource は scope null = どの Suspense にも関与しない (Solid 互換の意味論)。
 *
 * SSR 経路 (ADR 0030、B-5c): `bootstrapKey` option を渡すと:
 *   - server mode (renderToStringAsync 内): 1-pass で fetcher を ResourceScope に
 *     register、loading=true で markup。caller が Promise.allSettled で resolve →
 *     2-pass で hit を引き当てて resolved 値で markup
 *   - client mode: `__vidro_data.resources[key]` に hit があれば loading=false
 *     スタート (Suspense register しない、fetcher 呼ばない) = blink 解消。
 *     hit なしなら従来通り即時 fetch
 *   - bootstrapKey 未指定: client only で従来動作 (B-5b 互換)
 */
type ResourceOptions = {
  /**
   * SSR resolve / hydrate cache 命中用の一意 key。指定なら server で resolve →
   * client で初期値引き当て。重複 key は dev で warn (first-write-wins)。
   */
  bootstrapKey?: string;
};

class Resource<T> {
  #data: Signal<T | undefined>;
  #loading: Signal<boolean>;
  #error: Signal<unknown>;
  #fetcher: () => Promise<T>;
  // refetch のたびに increment。Promise の then/catch で自分の token と一致確認、
  // 一致しなければ古い fetch なので state を更新しない (router の loadToken と同パターン)。
  #token = 0;
  // 構築時の SuspenseScope (Suspense より外で作られたら null)。一度捕捉したら
  // resource の lifetime を通じて固定 (Solid 互換)。
  #suspense: SuspenseScope | null;
  // scope に register 中の場合は unregister 関数を保持。null なら未 register。
  #unregister: (() => void) | null = null;

  constructor(fetcher: () => Promise<T>, options?: ResourceOptions) {
    this.#fetcher = fetcher;
    this.#data = new Signal<T | undefined>(undefined);
    this.#loading = new Signal<boolean>(false);
    this.#error = new Signal<unknown>(undefined);
    this.#suspense = getCurrentSuspense();

    const renderer = getRenderer();

    if (renderer.isServer) {
      // --- server mode (ADR 0030 B-5c) ---
      if (options?.bootstrapKey !== undefined) {
        const scope = getCurrentResourceScope();
        const hit = scope?.getHit(options.bootstrapKey);
        if (hit !== undefined) {
          // 2-pass: caller (renderToStringAsync) が事前に resolve した値を引き当てる
          this.#applyBootstrapHit(hit);
          return;
        }
        // 1-pass: scope に fetcher を register、resolve は caller がやる
        scope?.registerFetcher(options.bootstrapKey, fetcher as () => Promise<unknown>);
      }
      // server では fetcher を即発火しない (Promise を返せない)。loading=true で
      // markup を作る。bootstrapKey なしは B-5b と同じ動作 (loading=true 表示)。
      this.#loading.value = true;
      return;
    }

    // --- client mode ---
    if (options?.bootstrapKey !== undefined) {
      const hit = readResourceBootstrap(options.bootstrapKey);
      if (hit !== undefined) {
        // bootstrap-hit: loading=false スタート、Suspense register せず、fetcher
        // 呼ばず。markup と client state が一致 → blink 消滅
        this.#applyBootstrapHit(hit);
        return;
      }
    }
    this.refetch();
  }

  /** resolved 後の値。pending / error 時は undefined。 */
  get value(): T | undefined {
    return this.#data.value;
  }

  /** fetcher が in-flight の間 true。resolve / reject で false に戻る。 */
  get loading(): boolean {
    return this.#loading.value;
  }

  /** fetcher が reject した場合の値。次の refetch 開始時に undefined にリセット。 */
  get error(): unknown {
    return this.#error.value;
  }

  /** 同じ fetcher を再実行。in-flight の旧 fetch の resolve は token 不一致で握り潰される。 */
  refetch(): void {
    const token = ++this.#token;
    // 同期的に loading=true、error=undefined に切替。新 fetch 開始の合図。
    batch(() => {
      this.#loading.value = true;
      this.#error.value = undefined;
    });
    // Suspense scope に register。既に register 済 (前回の refetch で resolve 前に
    // 再 refetch されたケース) なら count を維持し、次の resolve/reject で 1 回 unregister。
    if (this.#suspense && !this.#unregister) {
      this.#unregister = this.#suspense.register();
    }
    this.#fetcher().then(
      (data) => {
        if (token !== this.#token) return;
        // resolve 経路: data 確定 + loading=false を 1 effect 化
        batch(() => {
          this.#data.value = data;
          this.#loading.value = false;
        });
        this.#unregister?.();
        this.#unregister = null;
      },
      (err) => {
        if (token !== this.#token) return;
        // reject 経路: error 確定 + loading=false を 1 effect 化。data は前回値を保持
        // (Solid 互換、ユーザーが「直近成功時の値」を見続けられる)。
        batch(() => {
          this.#error.value = err;
          this.#loading.value = false;
        });
        this.#unregister?.();
        this.#unregister = null;
      },
    );
  }

  // bootstrap-hit (server 2-pass / client hit) 共通の状態反映。loading=false で
  // 確定済みとして扱い、Suspense register もしない (initial signal value 扱い)。
  #applyBootstrapHit(hit: BootstrapValue): void {
    if ("error" in hit && hit.error) {
      this.#error.value = hydrateBootstrapError(hit.error);
      this.#loading.value = false;
      return;
    }
    this.#data.value = (hit as { data?: T }).data;
    this.#loading.value = false;
  }
}

/** factory 形式の生成 API。class は internal、`export type { Resource }` で型のみ公開。 */
export function createResource<T>(
  fetcher: () => Promise<T>,
  options?: ResourceOptions,
): Resource<T> {
  return new Resource(fetcher, options);
}

export type { Resource };

// --- bootstrap helpers ---

/**
 * `__vidro_data.resources[key]` から bootstrap value を取り出す。client only。
 * router の readBootstrapData() と同じ shared cache (`readVidroData`) 経由なので、
 * Router と読み出し順序の心配なし (ADR 0030 3b-α)。
 */
function readResourceBootstrap(key: string): BootstrapValue | undefined {
  const data = readVidroData();
  if (!data) return undefined;
  const resources = data.resources as Record<string, BootstrapValue> | undefined;
  return resources?.[key];
}

/** SerializedError → Error。router の hydrateError と同形 (ADR 0030 5-a)。 */
function hydrateBootstrapError(raw: SerializedError): Error {
  const err = new Error(raw.message);
  if (raw.name) err.name = raw.name;
  if (raw.stack) err.stack = raw.stack;
  return err;
}
