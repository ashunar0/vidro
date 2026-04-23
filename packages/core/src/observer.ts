/** Effect が実装する通知受け手の契約。 */
export interface Observer {
  notify(): void;
  /** Signal の getter から呼ばれ、自分が依存した source を記録する。 */
  addSource(source: ObserverSource): void;
}

/** Observer に観測される側の契約。Signal が実装する。 */
export interface ObserverSource {
  removeObserver(observer: Observer): void;
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

// batch 関連の global state。複数 Signal 書き込みによる Effect 再実行を 1 回にまとめるため、
// batch 中は Observer.notify を即実行せず queue に積む。
let batchDepth = 0;
const pendingEffects = new Set<Observer>();

/** batch(fn) の最中かどうか。Effect.notify がこれを見て即実行 or enqueue を分岐する。 */
export function isBatching(): boolean {
  return batchDepth > 0;
}

/** Observer を batch queue に積む。既にある場合は重複排除される (Set)。 */
export function enqueueEffect(observer: Observer): void {
  pendingEffects.add(observer);
}

/** batch のネスト深さを +1 する。batch() から呼ばれる internal API。 */
export function enterBatch(): void {
  batchDepth++;
}

/** batch のネスト深さを -1 し、0 になった瞬間に queue を flush する。
 *  flush 中は depth を一時的に上げ戻さず 0 のまま — queue で走る Effect 内の signal 書き込みは
 *  即実行 (Effect 側の #running ガードが自己再入を吸収する)。 */
export function exitBatch(): void {
  batchDepth--;
  if (batchDepth === 0) flushPendingEffects();
}

function flushPendingEffects(): void {
  if (pendingEffects.size === 0) return;
  // 走らせる前に snapshot + clear。flush 中の signal 書き込みで再度 enqueue されても
  // 次回の flush で拾われる (ただし depth=0 なので即実行される)。
  const toRun = [...pendingEffects];
  pendingEffects.clear();
  for (const observer of toRun) observer.notify();
}
