import { Signal } from "./signal";
import { batch } from "./batch";

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
 * 本 primitive は **client only**。SSR で resource を resolve して bootstrap data
 * 経由で hydrate cache 命中させる仕組みは B-5c で別途設計する。
 */
class Resource<T> {
  #data: Signal<T | undefined>;
  #loading: Signal<boolean>;
  #error: Signal<unknown>;
  #fetcher: () => Promise<T>;
  // refetch のたびに increment。Promise の then/catch で自分の token と一致確認、
  // 一致しなければ古い fetch なので state を更新しない (router の loadToken と同パターン)。
  #token = 0;

  constructor(fetcher: () => Promise<T>) {
    this.#fetcher = fetcher;
    this.#data = new Signal<T | undefined>(undefined);
    this.#loading = new Signal<boolean>(false);
    this.#error = new Signal<unknown>(undefined);
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
    this.#fetcher().then(
      (data) => {
        if (token !== this.#token) return;
        // resolve 経路: data 確定 + loading=false を 1 effect 化
        batch(() => {
          this.#data.value = data;
          this.#loading.value = false;
        });
      },
      (err) => {
        if (token !== this.#token) return;
        // reject 経路: error 確定 + loading=false を 1 effect 化。data は前回値を保持
        // (Solid 互換、ユーザーが「直近成功時の値」を見続けられる)。
        batch(() => {
          this.#error.value = err;
          this.#loading.value = false;
        });
      },
    );
  }
}

/** factory 形式の生成 API。class は internal、`export type { Resource }` で型のみ公開。 */
export function createResource<T>(fetcher: () => Promise<T>): Resource<T> {
  return new Resource(fetcher);
}

export type { Resource };
