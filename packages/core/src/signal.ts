import { getCurrentObserver, type Observer, type ObserverSource } from "./observer";

/** 値を 1 つ保持し、変更時に購読者へ通知する reactive primitive。 */
export class Signal<T> implements ObserverSource {
  #value: T;
  #observers = new Set<Observer>();
  #subscribers = new Set<(value: T) => void>();

  constructor(initial: T) {
    this.#value = initial;
  }

  /** 読み取り。Effect 実行中なら自動で依存として記録する。 */
  get value(): T {
    const observer = getCurrentObserver();
    if (observer !== null) {
      this.#observers.add(observer);
      observer.addSource(this);
    }
    return this.#value;
  }

  /** 書き込み。同値ならスキップ、違えば全購読者へ同期通知。 */
  set value(next: T) {
    // Object.is: NaN→NaN を等価扱いするため === ではなくこれを使う
    if (Object.is(this.#value, next)) return;
    this.#value = next;
    // 通知中に Observer が #observers を変更する (Effect が再登録する) ため、snapshot を取って iterate する
    // eslint-disable-next-line unicorn/no-useless-spread
    for (const observer of [...this.#observers]) observer.notify();
    // eslint-disable-next-line unicorn/no-useless-spread
    for (const subscriber of [...this.#subscribers]) subscriber(next);
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

  /** Observer を依存から外す。Effect の再実行 / dispose で使う internal API。 */
  removeObserver(observer: Observer): void {
    this.#observers.delete(observer);
  }
}

/** factory 形式の生成 API。中身は new Signal と等価。 */
export function signal<T>(initial: T): Signal<T> {
  return new Signal(initial);
}
