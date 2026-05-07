// server-side で renderToStringAsync が resource の bootstrap-hit / fetcher
// register を仲介するための scope (ADR 0030、B-5c)。
//
// 流れ (現状 = 2-pass model):
//   1-pass: 空 resolved + 空 fetchers の scope を立てて renderToString。Resource
//           constructor が server mode + bootstrapKey 指定を見たら、fetcher を
//           scope.fetchers に register (重複 key は first-write-wins + dev warn)
//   resolve: caller (renderToStringAsync) が scope.fetchers を Promise.allSettled
//           で待ち、resolved/rejected を BootstrapValue に整形して new scope の
//           resolved Map に詰める
//   2-pass: resolved 入りの scope で renderToString。Resource constructor が
//           bootstrap-hit branch を通り、resolved 値で markup が完成する
//
// ADR 0064 (1-pass 統一) 移行中:
//   - `resolved` registry を導入済 (本ファイル) — Resource ctor が server mode
//     即 await して値を直接書き込む先。Phase 2 で Resource 側を書き換え、
//     Phase 3 で renderToStringAsync を async tree walk に置換。
//   - `fetchers` / `registerFetcher` は Phase 2 で Resource から呼ばれなくなり、
//     Phase 4 (streaming SSR boundary model 移行) 後に削除予定。
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
   * bootstrapKey → 集めた fetcher。1-pass 2-pass model で renderToStringAsync が
   * 外側で Promise.allSettled する経路。ADR 0064 Phase 2 で Resource 側が直接
   * `registerResolved` に書く形に置き換わるため deprecate 予定。
   */
  readonly fetchers = new Map<string, () => Promise<unknown>>();

  /**
   * bootstrapKey → resolved 値 (BootstrapValue)。constructor で初期値を受け取ると
   * 既存 2-pass 経路 (renderToStringAsync 2-pass / flushBoundary boundary-pass) で
   * Resource ctor が引き当てる先になる。ADR 0064 Phase 2 以降は Resource ctor が
   * `registerResolved` で直接書き込む 1-pass async tree walk の唯一の registry に
   * 純化する。
   */
  readonly resolved = new Map<string, BootstrapValue>();

  constructor(initialResolved?: Map<string, BootstrapValue>) {
    if (initialResolved) {
      for (const [k, v] of initialResolved) this.resolved.set(k, v);
    }
  }

  /**
   * fetcher を register。重複 key は first-write-wins (同じ key = 同じ resource
   * semantics を user が保証する前提、ADR 0030 論点 7-a)。dev で warn。
   *
   * ADR 0064 Phase 2 で Resource ctor から呼ばれなくなる予定 (= 即 await して
   * `registerResolved` に書き込む形に変更)。Phase 4 で本 method ごと removal。
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

  /**
   * ADR 0064: Resource ctor が server mode で fetcher を await した結果を直接
   * 書き込むエントリ。重複 key は first-write-wins + dev warn (`registerFetcher`
   * と同じ semantics)。Phase 2 で Resource constructor から呼ばれるようになる。
   */
  registerResolved(key: string, value: BootstrapValue): void {
    if (this.resolved.has(key)) {
      console.warn(`[vidro] duplicate bootstrapKey "${key}" — keeping the first resolved value`);
      return;
    }
    this.resolved.set(key, value);
  }

  /** lookup。bootstrapKey に対応する resolved 値を返す。 */
  getResolved(key: string): BootstrapValue | undefined {
    return this.resolved.get(key);
  }
}

let currentScope: ResourceScope | null = null;

/**
 * scope を active にして fn を評価。fn の内側で Resource constructor が server
 * mode を見ると `getCurrentResourceScope()` で本 scope を取り出して fetcher を
 * register、または resolved を引き当てる。Owner.run と同じく try/finally で前 scope
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
