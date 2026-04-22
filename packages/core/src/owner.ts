/**
 * Reactive な副作用の親子 scope を表す容れ物。Effect や子 Owner は生成時に現在の
 * Owner へ自動登録され、Owner を dispose すれば配下のリソースがまとめて片付く。
 */
export class Owner {
  #parent: Owner | null;
  #children = new Set<Owner>();
  #cleanups: Array<() => void> = [];
  #disposed = false;

  // 省略時は現在アクティブな Owner を親にする (ネスト時の自然な挙動)
  constructor(parent: Owner | null = currentOwner) {
    this.#parent = parent;
    if (parent) parent.#children.add(this);
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  /** cleanup 関数を登録する。dispose 時に LIFO 順で呼ばれる。dispose 済みなら無視。 */
  addCleanup(fn: () => void): void {
    if (this.#disposed) return;
    this.#cleanups.push(fn);
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
