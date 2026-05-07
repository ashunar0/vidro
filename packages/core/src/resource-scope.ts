// server-side で renderToStringAsync / renderToReadableStream が resource の
// bootstrap-hit / 即時 fetch を仲介するための scope (ADR 0030 + ADR 0064)。
//
// ADR 0064 Phase 2 以降の流れ:
//   1-pass: 空 scope を立てて renderToString。Resource constructor が server mode
//           + bootstrapKey 指定を見たら、scope に既存 hit / pending が無ければ
//           その場で fetcher() を fire し、then-handler で scope.resolved に
//           書き込む promise を scope.pending に register。重複 key は dedup
//           (first-write-wins + dev warn)。
//   resolve: caller (renderToStringAsync 等) が `Promise.allSettled(scope.pending
//           .values())` を await。完了時点で scope.resolved は全 key 埋まっている。
//   2-pass: 同じ scope で renderToString。Resource constructor が getResolved で
//           hit を引き当て、resolved 値で markup が完成する。
//
// 1-pass model (= JSX 評価 1 回 + 効果遅延) は ADR 0064 Phase 3+ で renderer 側を
// 書き換えて実現する。Phase 2 時点では JSX 評価 2 回の wrap は維持される。
//
// suspense-scope と同パターンの module-level state + try/finally で push/pop。

export type SerializedError = { name: string; message: string; stack?: string };

/**
 * server resolve 結果。data 成功時は `{ data: T }`、reject 時は
 * `{ error: SerializedError }`。client 側 (router の hydrateError と同形式)
 * で `Error` instance に復元する。
 */
export type BootstrapValue = { data?: unknown } | { error: SerializedError };

export class ResourceScope {
  /**
   * bootstrapKey → resolved 値 (BootstrapValue)。constructor で初期値を seed
   * できる。Resource ctor は server mode で fetcher 完了時 / hit 引き当て時に
   * `registerResolved` で書き込み、JSX 2-pass 時の `getResolved` で読み出す。
   */
  readonly resolved = new Map<string, BootstrapValue>();

  /**
   * bootstrapKey → in-flight な fetcher の settled promise。Resource ctor が
   * server mode で fetcher を fire した時に register する。同 key で 2 回目以降の
   * Resource は dedup されて既存 promise に乗る (first-write-wins)。
   *
   * caller (renderToStringAsync / flushBoundary) は `Promise.allSettled(pending
   * .values())` で全完了を待ってから 2-pass / serialize に進む。
   */
  readonly pending = new Map<string, Promise<void>>();

  constructor(initialResolved?: Map<string, BootstrapValue>) {
    if (initialResolved) {
      for (const [k, v] of initialResolved) this.resolved.set(k, v);
    }
  }

  /**
   * Resource ctor が server mode で fetcher を await した結果を直接書き込む。
   * 重複 key は first-write-wins + dev warn (= 同 bootstrapKey で複数 Resource
   * を作るのは意図一致前提、ADR 0030 論点 7-a)。
   */
  registerResolved(key: string, value: BootstrapValue): void {
    if (this.resolved.has(key)) {
      console.warn(`[vidro] duplicate bootstrapKey "${key}" — keeping the first resolved value`);
      return;
    }
    this.resolved.set(key, value);
  }

  /**
   * Resource ctor が server mode で fetcher を fire した時に呼ぶ。同 key の
   * pending が既にあれば既存 promise を返し (= caller 側はそれを `#settled` に
   * 採用して二重 fetch を避ける)、無ければ新規 register。
   *
   * dedup 時に dev warn を 1 回だす。`registerResolved` の warn と semantics 揃え。
   */
  registerPending(key: string, settled: Promise<void>): Promise<void> {
    const existing = this.pending.get(key);
    if (existing !== undefined) {
      console.warn(`[vidro] duplicate bootstrapKey "${key}" — keeping the first fetcher`);
      return existing;
    }
    this.pending.set(key, settled);
    return settled;
  }

  /** lookup。bootstrapKey に対応する resolved 値を返す。 */
  getResolved(key: string): BootstrapValue | undefined {
    return this.resolved.get(key);
  }
}

/** Promise.allSettled の reject reason 等を SerializedError 形式に整形。 */
export function serializeBootstrapError(reason: unknown): SerializedError {
  if (reason instanceof Error) {
    return { name: reason.name, message: reason.message, stack: reason.stack };
  }
  return { name: "Error", message: String(reason) };
}

// ADR 0065 Phase 2: 共通 scope-context helper 経由で AsyncLocalStorage 化。
// async function component (ADR 0066) の continuation 内で `resource()` を作る
// 経路があった場合、`getCurrentResourceScope()` が null にならないようにする。
// runWithResourceScope の sync return 型は不変。
import { createScope } from "./scope-context";

const resourceScope = createScope<ResourceScope>();

/**
 * scope を active にして fn を評価。fn の内側で Resource constructor が server
 * mode を見ると `getCurrentResourceScope()` で本 scope を取り出して fetcher を
 * fire / pending register、または resolved を引き当てる。`scope-context` 経由で
 * AsyncLocalStorage を使うので、fn 内側の async 子孫 (= await 後の continuation)
 * でも scope が引ける (ADR 0065)。
 */
export function runWithResourceScope<T>(scope: ResourceScope, fn: () => T): T {
  return resourceScope.runWith(scope, fn);
}

/** 現在 active な scope を返す。renderToStringAsync 外なら null。 */
export function getCurrentResourceScope(): ResourceScope | null {
  return resourceScope.getCurrent();
}
