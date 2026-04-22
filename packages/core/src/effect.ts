import { setCurrentObserver, type Observer, type ObserverSource } from "./observer";
import { getCurrentOwner, Owner } from "./owner";

type CleanupFn = () => void;
type EffectFn = () => void | CleanupFn;

/** Signal 変更に追従して副作用を実行する reactive primitive。生成時に即実行、依存変更で同期再実行する。 */
export class Effect implements Observer {
  #fn: EffectFn;
  #sources = new Set<ObserverSource>();
  #cleanup: CleanupFn | null = null;
  // fn の内側で作られた子 Effect / 子 Owner を束ねる scope。再実行のたびに作り直して旧 scope を dispose する。
  // parent=null (detached) にして親 Owner の children には登録しない — 親 → Effect → childOwner の芋づる構造で十分。
  #childOwner: Owner | null = null;
  #disposed = false;
  #running = false;

  constructor(fn: EffectFn) {
    this.#fn = fn;
    // 現 Owner (scope) があれば自分を cleanup 対象として登録 — Owner.dispose() で巻き込み解放される
    getCurrentOwner()?.addCleanup(() => this.dispose());
    this.#run();
  }

  /** Signal からの通知を受け取り、再実行する。#running は再入ガード (run 中に自分宛ての notify が来ても無視する)。 */
  notify(): void {
    if (this.#disposed || this.#running) return;
    this.#run();
  }

  /** Signal の getter から呼ばれ、自分が依存した source を記録する。 */
  addSource(source: ObserverSource): void {
    this.#sources.add(source);
  }

  /** 全依存から自分を外し、cleanup と子 scope を解放して以降の再実行を止める。 */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#clearSources();
    this.#runCleanup();
    this.#disposeChildOwner();
  }

  // 本体の実行。前回の cleanup / 子 scope / 依存を掃除してから、新しい child Owner を立てて fn を走らせる。
  #run(): void {
    this.#running = true;
    this.#runCleanup();
    this.#clearSources();
    this.#disposeChildOwner();

    this.#childOwner = new Owner(null);
    const prev = setCurrentObserver(this);
    try {
      const result = this.#childOwner.run(() => this.#fn());
      if (typeof result === "function") this.#cleanup = result;
    } finally {
      setCurrentObserver(prev);
      this.#running = false;
    }
  }

  #disposeChildOwner(): void {
    if (this.#childOwner === null) return;
    const owner = this.#childOwner;
    this.#childOwner = null;
    owner.dispose();
  }

  #runCleanup(): void {
    if (this.#cleanup === null) return;
    const cleanup = this.#cleanup;
    this.#cleanup = null;
    cleanup();
  }

  #clearSources(): void {
    for (const source of this.#sources) source.removeObserver(this);
    this.#sources.clear();
  }
}

/** factory 形式の生成 API。中身は new Effect と等価。 */
export function effect(fn: EffectFn): Effect {
  return new Effect(fn);
}
