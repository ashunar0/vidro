import { Signal } from "./signal";

/**
 * Suspense primitive と createResource を繋ぐ集約 scope (ADR 0029、B-5b)。
 * Suspense は children() を `runWithSuspenseScope` で wrap して評価し、その間に
 * 構築された `createResource` は constructor で `getCurrentSuspense()` を
 * 捕捉して自分を scope に register する。scope は in-flight な resource 数を
 * count signal で集約し、`pending` (count > 0) を effect で購読することで
 * Suspense の fallback ↔ children 切替が自然に reactive 化する。
 *
 * ADR 0029 の signal-base 方式: throw promise を使わず、scope の count signal
 * を Vidro の effect 機構で track することで pending 状態の伝播を実現する。
 */
export class SuspenseScope {
  // in-flight resource 数。register/unregister で increment/decrement。
  #count = new Signal<number>(0);

  /**
   * resource 1 件分を pending として count に加算。返り値は 1 回限りの
   * unregister 関数で、resolve / reject 時に呼ぶと count を decrement する。
   * 二重呼びはガードで no-op。
   */
  register(): () => void {
    this.#count.value += 1;
    let unregistered = false;
    return () => {
      if (unregistered) return;
      unregistered = true;
      this.#count.value -= 1;
    };
  }

  /** count > 0 を effect 内で読むと count signal に依存登録される。 */
  get pending(): boolean {
    return this.#count.value > 0;
  }
}

// 現在 active な Suspense scope。runWithSuspenseScope の中だけ non-null。
// mount-queue の currentMountScope と同パターンの module-level state。
let currentSuspense: SuspenseScope | null = null;

/**
 * scope を active にして fn を評価。fn の内側で構築された createResource は
 * `getCurrentSuspense()` 経由で scope を捕捉する。Owner.run と同じく try/finally
 * で previous scope に戻す (nested Suspense 対応)。
 */
export function runWithSuspenseScope<T>(scope: SuspenseScope, fn: () => T): T {
  const prev = currentSuspense;
  currentSuspense = scope;
  try {
    return fn();
  } finally {
    currentSuspense = prev;
  }
}

/** 現在 active な scope を返す。Suspense より外で呼ばれると null。 */
export function getCurrentSuspense(): SuspenseScope | null {
  return currentSuspense;
}
