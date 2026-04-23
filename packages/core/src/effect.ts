import {
  enqueueEffect,
  isBatching,
  setCurrentObserver,
  type Observer,
  type ObserverSource,
} from "./observer";
import { getCurrentOwner, Owner } from "./owner";

type CleanupFn = () => void;
type EffectFn = () => void | CleanupFn;

/** Signal 変更に追従して副作用を実行する reactive primitive。生成時に即実行、依存変更で同期再実行する。 */
export class Effect implements Observer {
  #fn: EffectFn;
  #sources = new Set<ObserverSource>();
  #cleanup: CleanupFn | null = null;
  // fn の内側で作られた子 Effect / 子 Owner を束ねる scope。再実行のたびに作り直して旧 scope を dispose する。
  // parent は Effect 構築時の Owner を持つが attach: false で dispose tree からは切り離し、
  // error chain (handleError) だけ親に繋がる状態にする。
  #childOwner: Owner | null = null;
  #parentOwner: Owner | null;
  #disposed = false;
  #running = false;

  constructor(fn: EffectFn) {
    this.#fn = fn;
    // 構築時点の Owner を覚え、その cleanup に自分の dispose を登録 (Owner.dispose で巻き込み解放)
    this.#parentOwner = getCurrentOwner();
    this.#parentOwner?.addCleanup(() => this.dispose());
    this.#run();
  }

  /** Signal からの通知を受け取り、再実行する。#running は再入ガード (run 中に自分宛ての notify が来ても無視する)。
   *  batch 中は queue に積むだけで、batch が抜ける時にまとめて走る。 */
  notify(): void {
    if (this.#disposed || this.#running) return;
    if (isBatching()) {
      enqueueEffect(this);
      return;
    }
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
  // fn の throw は childOwner.runCatching が nearest ancestor の errorHandler に流す。
  #run(): void {
    this.#running = true;
    this.#runCleanup();
    this.#clearSources();
    this.#disposeChildOwner();

    this.#childOwner = new Owner(this.#parentOwner, { attach: false });
    const prev = setCurrentObserver(this);
    try {
      const result = this.#childOwner.runCatching(() => this.#fn());
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
