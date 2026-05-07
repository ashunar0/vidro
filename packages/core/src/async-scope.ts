// async function component (ADR 0066) が return する Promise<Node> を
// per-render で集約する scope。`renderToStringAsync` / `flushBoundary` /
// `flushRoot` が `Promise.allSettled(asyncScope.pending)` で全完了を待ってから
// serialize する流れに乗せる。
//
// ResourceScope (= bootstrapKey ベース named registry、dedup 機能あり) と責務分離:
//   - ResourceScope は bootstrapKey で named pending を管理し、key 重複は
//     first-write-wins + dev warn する
//   - AsyncScope は anonymous pending を扱う。component が複数 await を持っても、
//     dedup・cancel の必要がないので単純配列で十分 (= ADR 0066 Q1 確定形)
//
// Phase 1 (本ファイル新規作成) では infra のみ load する:
//   - 既存 SSR 経路 (renderToStringAsync / flushBoundary / flushRoot) で
//     空 AsyncScope を立てて runWithAsyncScope で wrap、allSettled に merge する
//   - h() 側はまだ Promise を register しない (= Phase 2 で着地)
//   - したがって本 scope は Phase 1 では「空配列を allSettled に渡すだけ」の
//     no-op 等価で動く
//
// suspense-scope / resource-scope と同パターンで scope-context 経由 ALS 化
// (ADR 0065)。async function component の continuation 内で nested async
// component が現れても、`getCurrentAsyncScope()` が `await` 越しに同じ scope を
// 引けるようにする (= ADR 0066 Phase 2 以降の前提条件)。

import { createScope } from "./scope-context";

export class AsyncScope {
  /**
   * h() の component branch で `type(propsProxy)` が Promise を返した時に、
   * その Promise を then-handler で wrap した settled promise を register する
   * (= Phase 2 で実装)。
   *
   * shape は単純配列 (Q1 確定): anonymous pending には key 不要、dedup・cancel が
   * 必要になったら拡張する split-when-confused 方針。caller (renderToStringAsync
   * 等) は `Promise.allSettled(scope.pending)` で全完了を待つ。
   */
  readonly pending: Promise<void>[] = [];

  /**
   * h() の component branch (Phase 2) または ErrorBoundary 連携 (Phase 4 以降) で
   * settled promise を register する。同 promise を 2 回 register しても害は
   * ないが、通常 1 component = 1 register の使い方を想定。
   */
  registerPending(settled: Promise<void>): void {
    this.pending.push(settled);
  }
}

const asyncScope = createScope<AsyncScope>();

/**
 * scope を active にして fn を評価。fn の内側で h() が Promise を返す component を
 * 評価したら `getCurrentAsyncScope()` で本 scope を取り出して registerPending する
 * (= Phase 2 で実装)。`scope-context` 経由で AsyncLocalStorage を使うので、fn
 * 内側の async 子孫 (= await 後の continuation) でも scope が引ける (ADR 0065)。
 */
export function runWithAsyncScope<T>(scope: AsyncScope, fn: () => T): T {
  return asyncScope.runWith(scope, fn);
}

/** 現在 active な scope を返す。renderToStringAsync 外なら null。 */
export function getCurrentAsyncScope(): AsyncScope | null {
  return asyncScope.getCurrent();
}
