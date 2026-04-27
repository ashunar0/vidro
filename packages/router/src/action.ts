// Phase 3 R-mid-1 (ADR 0038) の action primitive 公開 API。
// loader と同じ場所 (`server.ts`) に export された action 関数を、Web 標準の
// `<form method="post">` か programmatic な `sub.submit()` から呼び出して、
// 結果を per-key signal で読む。
//
// state ライフサイクル設計 (B-γ):
//   submission state (value/pending/error の signal セット) は **module scope の
//   registry に key 単位で格納** する。call-order ベースの自動採番 (React hooks
//   風 B-α) は magic で fragile なので採用せず、user が明示的に文字列 key を
//   渡す形 (= Vidro 哲学の Hono的透明性と整合)。
//
//   理由: loader 自動 revalidate (= reset() による swap) で component tree が
//   再構築されても、registry が module scope にあれば action 結果が消えずに
//   残り、Remix UX (POST/Redirect/GET の "Added: ..." 表示) を維持できる。
//   per-component instance の state では swap で破棄される。
//
//   trade-off: page 跨ぎで state が残る (= /notes で submit → /about に
//   navigate → /notes 戻ると古い value 見える)。toy 段階では受容、navigation
//   単位の clear API は別 ADR (Phase 5)。
//
// public:
//   - `submission<typeof action>(key?)` factory: key 単位で signal セットを共有。
//     省略時は "default" key (= R-min 互換、1 form の単純ケース)。複数 form は
//     `submission("create")` / `submission("delete")` のように明示。
//   - `Submission<T>` 型: bind() / submit() 込みの戻り値 shape
//   - `ActionArgs<R>` / `AnyAction` / `SubmissionError` 型
//
// internal (router.tsx 経由のみ参照):
//   - `_getSubmissionMutator(key)`: form delegation が registry から submission
//     state を引き当てる lookup
//   - `_registerDispatcher(d)`: Router の client mode が dispatcher を登録、
//     `submission.submit()` がこの dispatcher 経由で fetch + state mutator を呼ぶ。
//     SSR や Router 外では dispatcher 不在で submit() は no-op + warn。

import { signal, type Signal } from "@vidro/core";
import type { Routes } from "./page-props";

/**
 * action 関数が server 側で受け取る引数。`R` に route path (例: `"/users/:id"`)
 * を渡すと params の型が RouteMap から自動展開される。LoaderArgs と同形式で揃え、
 * 同じ route の loader / action が同じ params 型を共有する。
 */
export type ActionArgs<R extends keyof Routes = keyof Routes> = {
  request: Request;
  params: Routes[R]["params"];
};

/**
 * action として受け入れる関数の最低条件。`Submission<A>` の generic 制約に使う。
 * params shape は route ごとに異なるので `any` で受けて、本当の型は
 * `Awaited<ReturnType<A>>` で個別に取り出す (PageProps と同じ idiom)。
 */
export type AnyAction = (args: { request: Request; params: any }) => Promise<unknown> | unknown;

/**
 * server 側で serialize された Error 表現 (router/server.ts の SerializedError と
 * 等価)。`submission.error.value` の type 注釈用に export する。
 */
export type SubmissionError = { name: string; message: string; stack?: string };

/**
 * `submission()` の `submit(input)` で受け入れる入力。
 * - `FormData` → multipart (browser が boundary 付きで Content-Type を設定)
 * - `URLSearchParams` → application/x-www-form-urlencoded
 * - plain object → default は JSON、`encoding: "form"` 指定で urlencoded
 */
export type SubmitInput = FormData | URLSearchParams | Record<string, unknown>;

export type SubmitOptions = {
  /** plain object 入力時の encoding。default: "json"。FormData/URLSearchParams 入力時は無視。 */
  encoding?: "json" | "form";
  /** action URL。default: 現在の pathname。 */
  action?: string;
};

/**
 * `submission()` factory の戻り値。Resource (ADR 0028) と同形式の signal-like API
 * + form binding (`bind()`) + programmatic submit (`submit()`)。
 */
export type Submission<T> = {
  value: Signal<T | undefined>;
  pending: Signal<boolean>;
  error: Signal<SubmissionError | undefined>;
  /** state を初期化 (value/error/pending を全てクリア)。 */
  reset(): void;
  /** `<form {...sub.bind()}>` で spread。`data-vidro-sub` attribute 1 個を返す。 */
  bind(): { "data-vidro-sub": string };
  /** programmatic submit。SSR / Router 外では no-op + warn。 */
  submit(input?: SubmitInput, opts?: SubmitOptions): Promise<void>;
};

// ---- internal: per-key registry + dispatcher ----

/** form delegation / submit() が呼ぶ state mutator 集合 (key 単位で永続)。 */
type SubmissionMutator = {
  setResult: (r: unknown) => void;
  setError: (e: SubmissionError) => void;
  setPending: (v: boolean) => void;
  isPending: () => boolean;
  // signal を expose して submission() factory が外から読めるように。
  // factory の戻り値 (Submission<T>) で .value / .pending / .error を返すため。
  _value: Signal<unknown>;
  _pending: Signal<boolean>;
  _error: Signal<SubmissionError | undefined>;
};

/** `submit()` が依頼する dispatch 仕様。Router 側 (client mode) が実装を提供。 */
export type SubmitDispatcher = {
  dispatch(
    path: string,
    mutator: SubmissionMutator,
    fetchInit: { body: BodyInit; headers: Record<string, string> },
  ): Promise<void>;
};

const _registry = new Map<string, SubmissionMutator>();
let _dispatcher: SubmitDispatcher | null = null;

/** form delegation (router.tsx) が data-vidro-sub attribute 経由で呼ぶ lookup。 */
export const _getSubmissionMutator = (key: string): SubmissionMutator | undefined =>
  _registry.get(key);

/**
 * test 用: registry 全エントリの state を初期化 (entries 自体は残す = 既存の
 * subscriber を切らない)。`beforeEach` で「使ったキーを列挙して reset」する
 * 形だと将来テストが増えた時に静かに leak する (review fix #5) ため、全 entry を
 * 一括 reset する経路を用意。production code では使わない。
 */
export function _resetRegistryForTest(): void {
  _registry.forEach((m) => {
    m._value.value = undefined;
    m._error.value = undefined;
    m._pending.value = false;
  });
}

/**
 * dispatcher を登録 (= Router の client mode mount)。返値は unregister 関数で、
 * Router の onCleanup から呼ばれる。multiple Router 同時 mount は想定しない
 * (= toy 段階、後勝ち上書きで別 Router の dispatcher は無効化される)。
 */
export function _registerDispatcher(d: SubmitDispatcher): () => void {
  _dispatcher = d;
  return () => {
    if (_dispatcher === d) _dispatcher = null;
  };
}

/**
 * 現在の form submission の state を読む factory (per-key)。
 *
 * 使い方:
 * ```tsx
 * import { submission } from "@vidro/router";
 * import type { action } from "./server";
 *
 * // 単一 form: key 省略 ("default" key で共有)
 * const sub = submission<typeof action>();
 *
 * // 複数 form: 明示 key で独立管理
 * const subCreate = submission<typeof action>("create");
 * const subDelete = submission<typeof action>("delete");
 * <form method="post" {...subCreate.bind()}>...</form>
 *
 * // programmatic
 * await subCreate.submit({ title: "foo" });               // JSON
 * await subCreate.submit(formData);                        // multipart
 * ```
 *
 * 同じ key で複数回呼ぶと **同じ signal セットを共有** する。state は module
 * scope の registry に格納され、loader 自動 revalidate (= component swap) を
 * 跨いで保持される (= Remix UX 維持の核)。
 */
export function submission<A extends AnyAction = AnyAction>(
  key: string = "default",
): Submission<Awaited<ReturnType<A>>> {
  const mutator = getOrCreateMutator(key);

  const submit = async (input?: SubmitInput, opts?: SubmitOptions): Promise<void> => {
    if (mutator.isPending()) return; // 同 key の連打 guard

    if (!_dispatcher) {
      // SSR / Router 外。silent ではなく console.warn で気付ける形に。
      console.warn(
        "[vidro/router] submission.submit() called without a mounted Router (no dispatcher).",
      );
      return;
    }

    const path = opts?.action ?? defaultPathname();
    const { body, headers } = encodeSubmitBody(input, opts?.encoding);
    await _dispatcher.dispatch(path, mutator, { body, headers });
  };

  return {
    value: mutator._value as Signal<Awaited<ReturnType<A>> | undefined>,
    pending: mutator._pending,
    error: mutator._error,
    reset() {
      mutator._value.value = undefined;
      mutator._error.value = undefined;
      mutator._pending.value = false;
    },
    bind() {
      return { "data-vidro-sub": key };
    },
    submit,
  };
}

/** registry から key の mutator を取得、無ければ signals を新規作成して登録。 */
function getOrCreateMutator(key: string): SubmissionMutator {
  let mutator = _registry.get(key);
  if (mutator) return mutator;

  const value = signal<unknown>(undefined);
  const pending = signal(false);
  const error = signal<SubmissionError | undefined>(undefined);

  mutator = {
    setResult(r) {
      value.value = r;
      error.value = undefined;
    },
    setError(e) {
      error.value = e;
      value.value = undefined;
    },
    setPending(v) {
      pending.value = v;
    },
    isPending() {
      return pending.value;
    },
    _value: value,
    _pending: pending,
    _error: error,
  };
  _registry.set(key, mutator);
  return mutator;
}

/**
 * default action path: window.location.pathname。SSR では `"/"` fallback。
 * `submission.submit()` の `opts.action` 未指定時に使う。
 */
function defaultPathname(): string {
  if (typeof window === "undefined") return "/";
  return window.location.pathname;
}

/**
 * submit input を fetch body + headers に変換する。推論ルール:
 * - 入力なし → 空 FormData (Content-Type は browser default = multipart)
 * - FormData → そのまま (Content-Type は browser が boundary 込みで設定)
 * - URLSearchParams → そのまま + `application/x-www-form-urlencoded`
 * - plain object + encoding="form" → URLSearchParams 化 + urlencoded
 * - plain object (default) → JSON.stringify + `application/json`
 *
 * server 側 action 内で `request.formData()` か `request.json()` を user code が
 * 選ぶ前提 (framework は content-type を参照しない)。
 */
function encodeSubmitBody(
  input: SubmitInput | undefined,
  encoding: "json" | "form" | undefined,
): { body: BodyInit; headers: Record<string, string> } {
  if (input == null) {
    return { body: new FormData(), headers: {} };
  }
  if (input instanceof FormData) {
    return { body: input, headers: {} };
  }
  if (input instanceof URLSearchParams) {
    return {
      body: input,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    };
  }
  // plain object
  if (encoding === "form") {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(input)) {
      params.set(k, stringifyFormValue(v));
    }
    return {
      body: params,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    };
  }
  return {
    body: JSON.stringify(input),
    headers: { "Content-Type": "application/json" },
  };
}

/**
 * URLSearchParams 用の値変換。null/undefined は空文字、primitive は String()、
 * object は JSON 文字列化 (= "[object Object]" を避ける)。
 *
 * 注意: `File` / `Blob` は `JSON.stringify` で `"{}"` になる (= バイナリ欠落)。
 * バイナリを送信するなら `encoding: "form"` ではなく **FormData を直接渡す**
 * 形にする (= `submit(formData)`)。配列も `"[1,2,3]"` 文字列になり、
 * PHP/Laravel 流の `a[]=1&a[]=2` 形式にはならない (= toy 段階の受容、
 * production 化時は qs ライブラリ等で richer encoding)。
 */
function stringifyFormValue(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  return JSON.stringify(v);
}
