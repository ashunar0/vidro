import { getCurrentObserver, type Observer } from "./observer";

/** 値を 1 つ保持し、変更時に購読者へ通知する reactive primitive。 */
export class Signal<T> {
  #value: T;
  #observers = new Set<Observer>();
  #subscribers = new Set<(value: T) => void>();

  constructor(initial: T) {
    this.#value = initial;
  }

  /** 読み取り。Effect 実行中なら自動で依存として記録する。 */
  get value(): T {
    const observer = getCurrentObserver();
    if (observer !== null) this.#observers.add(observer);
    return this.#value;
  }

  /** 書き込み。同値ならスキップ、違えば全購読者へ同期通知。 */
  set value(next: T) {
    // Object.is: NaN→NaN を等価扱いするため === ではなくこれを使う
    if (Object.is(this.#value, next)) return;
    this.#value = next;
    for (const observer of this.#observers) observer.notify();
    for (const subscriber of this.#subscribers) subscriber(next);
  }

  /** 自動 subscribe を経由せず現在値だけ返す。 */
  peek(): T {
    return this.#value;
  }

  /** 明示購読。返り値の関数を呼ぶと解除される。 */
  subscribe(fn: (value: T) => void): () => void {
    this.#subscribers.add(fn);
    return () => {
      this.#subscribers.delete(fn);
    };
  }
}

/** factory 形式の生成 API。中身は new Signal と等価。 */
export function signal<T>(initial: T): Signal<T> {
  return new Signal(initial);
}
