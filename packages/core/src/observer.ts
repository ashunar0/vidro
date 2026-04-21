/** Effect が実装する通知受け手の契約。 */
export interface Observer {
  notify(): void;
}

// 現在実行中の Observer。Signal の getter はここを覗いて依存関係を記録する。
let currentObserver: Observer | null = null;

/** 現在の Observer を返す。 */
export function getCurrentObserver(): Observer | null {
  return currentObserver;
}

/** Observer を差し替え、直前の値を返す (呼び出し側が後で戻すために保持する)。 */
export function setCurrentObserver(next: Observer | null): Observer | null {
  const prev = currentObserver;
  currentObserver = next;
  return prev;
}

/** 依存追跡オフの状態で fn を実行する。 */
export function untrack<T>(fn: () => T): T {
  const prev = setCurrentObserver(null);
  // 例外時にも currentObserver を必ず元に戻す
  try {
    return fn();
  } finally {
    setCurrentObserver(prev);
  }
}
