/**
 * Reactive な副作用の親子 scope を表す容れ物。Effect や子 Owner は生成時に現在の
 * Owner へ自動登録され、Owner を dispose すれば配下のリソースがまとめて片付く。
 *
 * エラー伝播: 各 Owner は optional な errorHandler を持つ。runCatching が捕まえた
 * 例外は handleError → 自身の handler → 親 → ... と遡り、root まで無ければ再 throw。
 * これが ErrorBoundary の catch chain 本体。
 */
export class Owner {
  #parent: Owner | null;
  #children = new Set<Owner>();
  #cleanups: Array<() => void> = [];
  #disposed = false;
  #errorHandler: ((err: unknown) => void) | null = null;

  // 省略時は現在アクティブな Owner を親にする (ネスト時の自然な挙動)。
  // attach: false にすると親の #children に入らず、親 dispose に巻き込まれない。
  // #parent 参照だけは持つので handleError() の chain は遡れる — Effect の childOwner
  // はこの形で作り、「dispose tree には載せないが error chain には載る」を両立する。
  constructor(parent: Owner | null = currentOwner, options: { attach?: boolean } = {}) {
    const attach = options.attach ?? true;
    this.#parent = parent;
    if (parent && attach) parent.#children.add(this);
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  /** cleanup 関数を登録する。dispose 時に LIFO 順で呼ばれる。dispose 済みなら無視。 */
  addCleanup(fn: () => void): void {
    if (this.#disposed) return;
    this.#cleanups.push(fn);
  }

  /** この scope の error handler を設定する (ErrorBoundary から使う internal API)。 */
  setErrorHandler(fn: (err: unknown) => void): void {
    this.#errorHandler = fn;
  }

  /** err を handler chain に届ける。自分に handler があれば呼び、無ければ親へ。
   *  root まで無ければ再 throw して呼び出し側に返す。handler 内で throw すると親へ伝播。 */
  handleError(err: unknown): void {
    if (this.#errorHandler) {
      this.#errorHandler(err);
      return;
    }
    if (this.#parent) {
      this.#parent.handleError(err);
      return;
    }
    throw err;
  }

  /** この Owner を active にして fn を実行する。fn 内で作られた Owner / Effect は子として登録される。 */
  run<T>(fn: () => T): T {
    const prev = setCurrentOwner(this);
    try {
      return fn();
    } finally {
      setCurrentOwner(prev);
    }
  }

  /** run の try/catch 版。例外は handleError に流し、fn の返り値は throw 時 undefined になる。
   *  currentOwner は handleError 実行前に元へ戻す (handler が外の scope で動く方が自然)。 */
  runCatching<T>(fn: () => T): T | undefined {
    const prev = setCurrentOwner(this);
    try {
      return fn();
    } catch (err) {
      setCurrentOwner(prev);
      this.handleError(err);
      return undefined;
    } finally {
      // 正常 return と catch 後の両方で実行されるが、setCurrentOwner は冪等なので問題ない。
      setCurrentOwner(prev);
    }
  }

  /** 配下の子 Owner と cleanup を全て解放し、親からも自分を外す。2 回目以降は no-op。 */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;

    // iteration 中の mutation を避けるため snapshot → clear してから子を dispose する
    const children = [...this.#children];
    this.#children.clear();
    for (const child of children) child.dispose();

    // cleanup は登録と逆順 (LIFO = スタックを畳む順序)
    for (let i = this.#cleanups.length - 1; i >= 0; i--) {
      this.#cleanups[i]();
    }
    this.#cleanups.length = 0;

    if (this.#parent) {
      this.#parent.#children.delete(this);
      this.#parent = null;
    }
  }
}

// 現在アクティブな Owner。Effect の constructor から参照して自己登録する。
let currentOwner: Owner | null = null;

/** 現在の Owner を返す。 */
export function getCurrentOwner(): Owner | null {
  return currentOwner;
}

// current owner を差し替え、直前の値を返す (呼び出し側が finally で戻すために保持する)
function setCurrentOwner(next: Owner | null): Owner | null {
  const prev = currentOwner;
  currentOwner = next;
  return prev;
}

/**
 * 現在の Owner context と切り離して新しい root scope を作り、その中で fn を実行する。
 * fn は dispose 関数を受け取り、任意タイミングで scope 全体を破棄できる。
 * Stage 1 では internal 専用 (public export しない)。
 */
export function effectScope<T>(fn: (dispose: () => void) => T): T {
  const owner = new Owner(null);
  const dispose = () => owner.dispose();
  return owner.run(() => fn(dispose));
}

/** 現在の Owner に cleanup 関数を登録する。Owner 外で呼ばれた場合は何もしない。 */
export function onCleanup(fn: () => void): void {
  currentOwner?.addCleanup(fn);
}
