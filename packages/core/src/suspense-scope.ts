import { Signal } from "./signal";

/**
 * Suspense primitive と resource を繋ぐ集約 scope (ADR 0029、B-5b)。
 * Suspense は children() を `runWithSuspenseScope` で wrap して評価し、その間に
 * 構築された `resource` は constructor で `getCurrentSuspense()` を
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
   *
   * count の読みは `peek()` 経由 (track 外) で取り、setter にだけ書く。
   * register/unregister の呼び元 (例: Resource constructor 内の source-tracking
   * effect) が currentObserver で active なとき、`this.#count.value` の getter で
   * 当該 effect が #count を dep に拾ってしまうと、unregister 時の `value -= 1`
   * setter で **意図せず effect が再実行される** ため (ADR 0032 で発覚)。
   */
  register(): () => void {
    this.#count.value = this.#count.peek() + 1;
    let unregistered = false;
    return () => {
      if (unregistered) return;
      unregistered = true;
      this.#count.value = this.#count.peek() - 1;
    };
  }

  /** count > 0 を effect 内で読むと count signal に依存登録される。 */
  get pending(): boolean {
    return this.#count.value > 0;
  }
}

// ADR 0065 Phase 3: 共通 scope-context helper 経由で AsyncLocalStorage 化。
// async function component (ADR 0066) の continuation 内で resource() を作る
// 経路があった場合、Suspense scope が null にならないようにする。
import { createScope } from "./scope-context";

const suspenseScope = createScope<SuspenseScope>();

/**
 * scope を active にして fn を評価。fn の内側で構築された resource は
 * `getCurrentSuspense()` 経由で scope を捕捉する。`scope-context` 経由で
 * AsyncLocalStorage を使うので、fn 内側の async 子孫 (= await 後の continuation)
 * でも Suspense scope が引ける (ADR 0065)。
 */
export function runWithSuspenseScope<T>(scope: SuspenseScope, fn: () => T): T {
  return suspenseScope.runWith(scope, fn);
}

/** 現在 active な scope を返す。Suspense より外で呼ばれると null。 */
export function getCurrentSuspense(): SuspenseScope | null {
  return suspenseScope.getCurrent();
}
