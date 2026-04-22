import {
  getCurrentObserver,
  setCurrentObserver,
  type Observer,
  type ObserverSource,
} from "./observer";
import { getCurrentOwner } from "./owner";

/**
 * memoize された派生値 primitive。依存する Signal / Computed の値から導出し、
 * `.value` が読まれた時に必要なら再計算する (pull-based lazy evaluation)。
 *
 * Observer (依存に通知を受ける) と ObserverSource (自分を観測する Effect 等へ
 * 通知を送る) の両方を実装することで、Signal → Computed → Effect の reactive
 * graph の中継ノードとして機能する。
 */
export class Computed<T> implements Observer, ObserverSource {
  #fn: () => T;
  #value!: T;
  #sources = new Set<ObserverSource>();
  #observers = new Set<Observer>();
  #dirty = true;
  #disposed = false;

  constructor(fn: () => T) {
    this.#fn = fn;
    // 現 Owner があれば自分の dispose を登録 (scope 解放で巻き込まれる)
    getCurrentOwner()?.addCleanup(() => this.dispose());
  }

  /** 値を読む。現 Observer があれば自分を source として登録し、dirty なら再計算する。 */
  get value(): T {
    if (!this.#disposed) {
      const observer = getCurrentObserver();
      if (observer) {
        this.#observers.add(observer);
        observer.addSource(this);
      }
      if (this.#dirty) this.#recompute();
    }
    return this.#value;
  }

  /** 依存 (Signal / Computed) の通知を受ける。dirty 化して自分の observer へ伝播する。
   *  通知中に observer 側が自身を再登録する (Effect の clearSources → addSource のサイクル) ため、
   *  snapshot を取ってから iterate する。でないと同じ observer を無限に再訪する。 */
  notify(): void {
    if (this.#disposed || this.#dirty) return;
    this.#dirty = true;
    // eslint-disable-next-line unicorn/no-useless-spread
    for (const observer of [...this.#observers]) observer.notify();
  }

  /** 自分が依存した source を記録する (再計算時に依存を張り替えるため)。 */
  addSource(source: ObserverSource): void {
    this.#sources.add(source);
  }

  /** 自分を source として登録していた observer が依存を外す時に呼ばれる。 */
  removeObserver(observer: Observer): void {
    this.#observers.delete(observer);
  }

  /** 依存を全て外し、以降の再計算を止める。多重呼び出しは no-op。 */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#clearSources();
    this.#observers.clear();
  }

  #recompute(): void {
    this.#clearSources();
    const prev = setCurrentObserver(this);
    try {
      this.#value = this.#fn();
    } finally {
      setCurrentObserver(prev);
      this.#dirty = false;
    }
  }

  #clearSources(): void {
    for (const source of this.#sources) source.removeObserver(this);
    this.#sources.clear();
  }
}

/** factory 形式の生成 API。中身は new Computed と等価。 */
export function computed<T>(fn: () => T): Computed<T> {
  return new Computed(fn);
}
