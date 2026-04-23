/**
 * DOM 要素への参照を受け取るための箱 primitive。
 * `<input ref={myRef} />` の形で JSX に渡すと、要素が作られた瞬間に `.current` に代入される。
 *
 * Signal と違って reactive ではない (代入しても observer に通知しない)。要素は通常 replace
 * されず、1 回受け取ったら read するだけなので、依存追跡は不要。設計判断は
 * docs/decisions/0003-ref.md 参照。
 */
export class Ref<T> {
  /** 要素が attach されるまでは null。mount() の中で JSX 評価時に代入される。 */
  current: T | null = null;
}

/** factory 形式の生成 API。中身は new Ref と等価。Signal の signal() と同じパターン。 */
export function ref<T>(): Ref<T> {
  return new Ref<T>();
}
