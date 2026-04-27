// server-side で renderToStringAsync が createResource の bootstrap-hit / fetcher
// register を仲介するための scope (ADR 0030、B-5c)。
//
// 流れ:
//   1-pass: 空 hits + 空 fetchers の scope を立てて renderToString。Resource
//           constructor が server mode + bootstrapKey 指定を見たら、fetcher を
//           scope.fetchers に register (重複 key は first-write-wins + dev warn)
//   resolve: caller (renderToStringAsync) が scope.fetchers を Promise.allSettled
//           で待ち、resolved/rejected を BootstrapValue に整形して new scope の
//           hits に詰める
//   2-pass: hits 入りの scope で renderToString。Resource constructor が
//           bootstrap-hit branch を通り、resolved 値で markup が完成する
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
  /** bootstrapKey → 集めた fetcher。1-pass で register され、caller が resolve に使う。 */
  readonly fetchers = new Map<string, () => Promise<unknown>>();
  /** bootstrapKey → resolved 値。2-pass で Resource constructor が引き当てる。 */
  readonly hits = new Map<string, BootstrapValue>();

  constructor(hits?: Map<string, BootstrapValue>) {
    if (hits) {
      for (const [k, v] of hits) this.hits.set(k, v);
    }
  }

  /**
   * fetcher を register。重複 key は first-write-wins (同じ key = 同じ resource
   * semantics を user が保証する前提、ADR 0030 論点 7-a)。dev で warn。
   */
  registerFetcher(key: string, fetcher: () => Promise<unknown>): void {
    if (this.fetchers.has(key)) {
      // 同じ key を持つ resource が複数あっても fetch は 1 回。dev で気付ける
      // ように warn。prod では sink して navigation を続行する。
      console.warn(`[vidro] duplicate bootstrapKey "${key}" — keeping the first fetcher`);
      return;
    }
    this.fetchers.set(key, fetcher);
  }

  /** 2-pass 時の lookup。bootstrapKey に対応する resolved 値を返す。 */
  getHit(key: string): BootstrapValue | undefined {
    return this.hits.get(key);
  }
}

let currentScope: ResourceScope | null = null;

/**
 * scope を active にして fn を評価。fn の内側で Resource constructor が server
 * mode を見ると `getCurrentResourceScope()` で本 scope を取り出して fetcher を
 * register、または hit を引き当てる。Owner.run と同じく try/finally で前 scope
 * に戻す (nested 呼び出しでも安全)。
 */
export function runWithResourceScope<T>(scope: ResourceScope, fn: () => T): T {
  const prev = currentScope;
  currentScope = scope;
  try {
    return fn();
  } finally {
    currentScope = prev;
  }
}

/** 現在 active な scope を返す。renderToStringAsync 外なら null。 */
export function getCurrentResourceScope(): ResourceScope | null {
  return currentScope;
}
