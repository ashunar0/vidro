import { Signal } from "./signal";
import { batch } from "./batch";
import { effect } from "./effect";
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
 * primitive。Solid の `createResource` 相当 (Vidro factory 名は `resource`、
 * ADR 0032 で 1 単語規約に揃えた)。class instance + `.value` で他 primitive と
 * 統一感を持たせる (ADR 0006 / 0028 / 0032)。
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
 *
 * reactive source (ADR 0032): `resource(source, fetcher, options?)` の 3 引数
 * 形式で、source 関数を effect で track。source signal 変化で auto refetch、
 * `false` / `null` / `undefined` を返すと fetcher skip (gating、Solid 互換)。
 * pending 中は previous value を保持 (stale-while-revalidate)。
 */
type ResourceOptions = {
  /**
   * SSR resolve / hydrate cache 命中用の一意 key。指定なら server で resolve →
   * client で初期値引き当て。重複 key は dev で warn (first-write-wins)。
   */
  bootstrapKey?: string;
};

/** sourceful overload で source が gate を返した状態を示す sentinel 型。 */
type Gate = false | null | undefined;

class Resource<T> {
  #data: Signal<T | undefined>;
  #loading: Signal<boolean>;
  #error: Signal<unknown>;
  // sourceless 時は固定 fetcher、sourceful 時は最後に評価した source value で
  // bind した closure。`refetch()` は本フィールドを呼び直す。
  #fetcher: () => Promise<T>;
  // refetch / source 変化のたびに increment。Promise の then/catch で自分の
  // token と一致確認、一致しなければ古い fetch なので state を更新しない
  // (router の loadToken と同パターン)。
  #token = 0;
  // 構築時の SuspenseScope (Suspense より外で作られたら null)。一度捕捉したら
  // resource の lifetime を通じて固定 (Solid 互換)。
  #suspense: SuspenseScope | null;
  // scope に register 中の場合は unregister 関数を保持。null なら未 register。
  #unregister: (() => void) | null = null;

  /**
   * Constructor は overload 解析で 2 形態を受け付ける:
   *   - sourceless: `(fetcher, options?)`
   *   - sourceful : `(source, fetcher, options?)` — source が function で第 2
   *     引数も function なら sourceful と判定 (ADR 0032 論点 2)
   */
  constructor(
    arg1: (() => Promise<T>) | (() => unknown),
    arg2?: ((value: never) => Promise<T>) | ResourceOptions,
    arg3?: ResourceOptions,
  ) {
    this.#data = new Signal<T | undefined>(undefined);
    this.#loading = new Signal<boolean>(false);
    this.#error = new Signal<unknown>(undefined);
    this.#suspense = getCurrentSuspense();

    // arg2 が function なら sourceful、object か undefined なら sourceless
    let source: (() => unknown) | null = null;
    let userFetcher: ((value: unknown) => Promise<T>) | (() => Promise<T>);
    let options: ResourceOptions | undefined;
    if (typeof arg2 === "function") {
      source = arg1 as () => unknown;
      userFetcher = arg2 as (value: unknown) => Promise<T>;
      options = arg3;
    } else {
      userFetcher = arg1 as () => Promise<T>;
      options = arg2 as ResourceOptions | undefined;
    }
    // sourceless: #fetcher は値を引数取らない closure。sourceful: refetch() 用に
    // 「直近 source value で bind し直す」ために本フィールドを **書き換える** 形で
    // 動かす (constructor 直下では仮で 0 引数 fetcher を入れる)。
    this.#fetcher = source
      ? () => Promise.reject(new Error("[vidro] resource source not yet evaluated"))
      : (userFetcher as () => Promise<T>);

    const renderer = getRenderer();

    if (renderer.isServer) {
      // --- server mode (ADR 0030 B-5c、ADR 0032 sourceful 拡張) ---
      // sourceful 時は source() を 1 回評価 → fetcher(value) を register。
      // gating value (false/null/undef) は fetcher skip + loading=false。
      let serverFetcher: () => Promise<T>;
      if (source) {
        const value = source();
        if (isGate(value)) {
          // gate: fetch しない、loading=false で markup に入る (= 「待機中」表現)
          this.#loading.value = false;
          return;
        }
        serverFetcher = () => (userFetcher as (v: unknown) => Promise<T>)(value);
      } else {
        serverFetcher = userFetcher as () => Promise<T>;
      }

      if (options?.bootstrapKey !== undefined) {
        const scope = getCurrentResourceScope();
        const hit = scope?.getHit(options.bootstrapKey);
        if (hit !== undefined) {
          this.#applyBootstrapHit(hit);
          return;
        }
        scope?.registerFetcher(options.bootstrapKey, serverFetcher as () => Promise<unknown>);
      }
      this.#loading.value = true;
      return;
    }

    // --- client mode ---
    let startedWithHit = false;
    if (options?.bootstrapKey !== undefined) {
      const hit = readResourceBootstrap(options.bootstrapKey);
      if (hit !== undefined) {
        // bootstrap-hit: loading=false スタート、Suspense register せず、fetcher
        // 呼ばず。markup と client state が一致 → blink 消滅
        this.#applyBootstrapHit(hit);
        startedWithHit = true;
      }
    }

    if (source) {
      // sourceful: effect で source を track、変化で auto refetch。
      // bootstrap-hit が当たった場合は初回 invocation を skip して二重 fetch を回避。
      let skipNext = startedWithHit;
      effect(() => {
        const value = source!();
        if (skipNext) {
          skipNext = false;
          return;
        }
        if (isGate(value)) {
          this.#cancelInFlight();
          return;
        }
        this.#fetcher = () => (userFetcher as (v: unknown) => Promise<T>)(value);
        this.#startFetch();
      });
      return;
    }

    // sourceless: bootstrap-hit があれば fetcher 呼ばず、なければ即時 fetch
    if (!startedWithHit) {
      this.refetch();
    }
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

  /**
   * 同じ fetcher を再実行。sourceful の場合は直近 source value で bind し直し
   * 済み (effect 内で `#fetcher` が更新済み) なので、source 値を握ったまま再 fetch。
   * gate 時の refetch は no-op (#fetcher が直近で書き換えられていないので
   * "未評価" の reject closure が残っているケースに備え、まず loading=false を確認)。
   */
  refetch(): void {
    this.#startFetch();
  }

  /** 共通の fetch 起動。sourceless / sourceful / source 変化 で同じ機構を使う。 */
  #startFetch(): void {
    const token = ++this.#token;
    batch(() => {
      this.#loading.value = true;
      this.#error.value = undefined;
    });
    if (this.#suspense && !this.#unregister) {
      this.#unregister = this.#suspense.register();
    }
    this.#fetcher().then(
      (data) => {
        if (token !== this.#token) return;
        batch(() => {
          this.#data.value = data;
          this.#loading.value = false;
        });
        this.#unregister?.();
        this.#unregister = null;
      },
      (err) => {
        if (token !== this.#token) return;
        // reject 経路: error 確定 + loading=false。data は前回値を保持
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

  /** gate に変わったときに既存 pending を握り潰す処理。token++ で旧 then/catch を握り潰し。 */
  #cancelInFlight(): void {
    this.#token++;
    if (this.#loading.value) {
      this.#loading.value = false;
    }
    this.#unregister?.();
    this.#unregister = null;
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

/** sourceful overload で source の gate sentinel を判定。 */
function isGate(value: unknown): value is Gate {
  return value === false || value === null || value === undefined;
}

/**
 * factory 形式の生成 API (ADR 0006 + 0032)。class は internal、
 * `export type { Resource }` で型のみ公開。
 *
 * overload:
 *   - `resource(fetcher, options?)`
 *   - `resource(source, fetcher, options?)` — source 関数で auto refetch
 */
export function resource<T>(fetcher: () => Promise<T>, options?: ResourceOptions): Resource<T>;
export function resource<S, T>(
  source: () => S | false | null | undefined,
  fetcher: (value: S) => Promise<T>,
  options?: ResourceOptions,
): Resource<T>;
export function resource(
  arg1: (() => Promise<unknown>) | (() => unknown),
  arg2?: ((value: never) => Promise<unknown>) | ResourceOptions,
  arg3?: ResourceOptions,
): Resource<unknown> {
  return new Resource(
    arg1 as () => Promise<unknown>,
    arg2 as ((value: never) => Promise<unknown>) | ResourceOptions | undefined,
    arg3,
  );
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
