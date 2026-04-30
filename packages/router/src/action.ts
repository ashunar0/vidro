// ADR 0051: derive 派楽観更新 + intent pattern + per-route registry。
//
// state ライフサイクル設計:
//   submission instance (= 1 回の submit に対応する state slot) は **route path 単位の
//   registry に array で格納** する。各 instance は固有 id を持ち、`<For each={subs}>`
//   の key prop として使える。同 route 内の複数 form は HTML `<button name="intent">` で
//   区別する (= ADR 0051 の intent pattern、Remix `<Form>` 慣習)。
//
//   per-key string registry (ADR 0038) は廃止: 1 route = 1 action 規約 (= 設計書) を
//   維持するなら key 引数は構造的に不要で、key 由来の dual source of truth (`<form
//   data-vidro-sub="create">` ↔ `submission("create")`) と stringly-typed の問題が
//   解消する。
//
// public:
//   - `submission<A>()`: 現 route の最新 submission の **stable view** を返す。
//     未だ submission が無ければ全 signal が undefined / false を返す。
//     単発 form (Settings 等) の pending / error / input 表示用。
//   - `submissions<A>()`: 現 route の全 submission instance を array signal で返す。
//     複数 in-flight 楽観 UX で `<For each={subs.value}>` する用途。各要素は固有 id +
//     pending / value / error / input + retry() / clear()。
//   - `submit(input?, opts?)`: 現 route の action に programmatic 投げ。
//   - `Submission<T>` / `LatestSubmission<T>` / `ActionArgs<R>` / `AnyAction` /
//     `SubmissionError` 型。
//
// internal (router.tsx 経由のみ参照):
//   - `_createSubmissionInstance(...)`: 新 Submission を生成して array に push し、
//     state mutator + Submission を返す。form delegation / programmatic submit /
//     retry が共通で使う。
//   - `_registerDispatcher(d)`: Router の client mode が dispatcher を登録、
//     `submit()` 経路がこの dispatcher 経由で fetch + state mutator を呼ぶ。
//   - `_clearAllSubmissionState()`: navigation 単位 flush (ADR 0041 と同思想)。
//   - `_cleanupSuccessfulSubmissions(routePath)`: 同 page loader revalidate 完了で
//     呼ばれる auto-cleanup (= 楽観行を server 戻りで自動消滅、derive 派の核体験)。
//   - `_resetRegistryForTest()`: test 用全 flush。

import { computed, signal, type Signal } from "@vidro/core";
import type { Routes } from "./page-props";

/**
 * action 関数が server 側で受け取る引数。`R` に route path (例: `"/users/:id"`) を
 * 渡すと params の型が RouteMap から自動展開される。LoaderArgs と同形式。
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
export type AnyAction = (args: { request: Request; params: any }) => unknown;

/**
 * server 側で serialize された Error 表現 (router/server.ts の SerializedError と
 * 等価)。`submission.error.value` の type 注釈用に export する。
 */
export type SubmissionError = { name: string; message: string; stack?: string };

/**
 * `submit()` で受け入れる入力。
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
 * 1 つの submission instance。`submissions()` の配列要素。
 * lifecycle (ADR 0051):
 *   - 生成: form submit / submit() / retry() 時に新 instance、`pending = true`
 *   - success: `pending = false`、value 確定。同 route の loader revalidate
 *     完了で auto-cleanup (= array から remove) される
 *   - error: `pending = false`、error 確定。array に残留 (= retry / clear で操作)
 *   - clear(): array から外す。失敗を user 操作で消す経路
 *   - retry(): 同 input / 同 path で再 submit (= pending=true 再開、error クリア)
 *   - navigation: 全 flush
 */
export type Submission<T> = {
  /** array での stable identity (= `<For>` の key prop / 同一性判定に使う)。 */
  readonly id: string;
  readonly value: Signal<T | undefined>;
  readonly pending: Signal<boolean>;
  readonly error: Signal<SubmissionError | undefined>;
  readonly input: Signal<Record<string, unknown> | undefined>;
  /** 同 input / 同 path で再 submit。pending 中は no-op。 */
  retry(): Promise<void>;
  /** 自身を array から remove。dispatcher の参照は走り続けるが UI からは消える。 */
  clear(): void;
};

/**
 * `submission()` factory の戻り値。「現 route の最新 submission」の stable view。
 *
 * 各 signal は computed: 配列末尾の Submission の同名 signal を読む。
 * submission が未だ生成されていない / array が空 → value/error/input は undefined、
 * pending は false を返す。
 *
 * 単発 form (Settings 保存等) で「最新の状態」を読むだけのケースで使う。複数
 * in-flight を 1 つずつ扱うなら `submissions()` を使う。
 */
export type LatestSubmission<T> = {
  readonly value: Signal<T | undefined>;
  readonly pending: Signal<boolean>;
  readonly error: Signal<SubmissionError | undefined>;
  readonly input: Signal<Record<string, unknown> | undefined>;
};

// ---- internal: per-route slot + dispatcher ----

/** 1 つの submission の内部 state mutator (= router.tsx 経由)。 */
export type SubmissionState = {
  setResult: (r: unknown) => void;
  setError: (e: SubmissionError) => void;
  setPending: (v: boolean) => void;
  setInput: (v: Record<string, unknown> | undefined) => void;
  isPending: () => boolean;
  // signal を expose (factory が view を作るため)。
  readonly _value: Signal<unknown>;
  readonly _pending: Signal<boolean>;
  readonly _error: Signal<SubmissionError | undefined>;
  readonly _input: Signal<Record<string, unknown> | undefined>;
};

/** dispatcher 仕様。Router 側 (client mode) が実装を提供する。 */
export type SubmitDispatcher = {
  dispatch(
    path: string,
    state: SubmissionState,
    fetchInit: { body: BodyInit; headers: Record<string, string> },
  ): Promise<void>;
};

/** route path 1 つあたりの submission slot。 */
type RouteSlot = {
  active: Signal<Submission<unknown>[]>;
};

const _registry = new Map<string, RouteSlot>();
let _dispatcher: SubmitDispatcher | null = null;
let _idCounter = 0;

function getOrCreateSlot(routePath: string): RouteSlot {
  let slot = _registry.get(routePath);
  if (slot) return slot;
  slot = { active: signal<Submission<unknown>[]>([]) };
  _registry.set(routePath, slot);
  return slot;
}

function nextId(): string {
  return `s${++_idCounter}`;
}

/**
 * dispatcher 登録 (= Router の client mode mount)。返値は unregister 関数で、
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
 * navigation 単位の全 submission flush (ADR 0041)。Router client mode が
 * `currentPathname` の変化を effect で subscribe して呼ぶ。
 *
 * 全 route slot の active 配列を空にする。各 Signal の identity は保持され、
 * 既存の computed (= LatestSubmission の view) は引き続き動く。
 */
export function _clearAllSubmissionState(): void {
  _registry.forEach((slot) => {
    slot.active.value = [];
  });
}

/**
 * 同 page loader revalidate 完了時に呼ばれる auto-cleanup (ADR 0051)。
 *
 * 該当 route の active 配列から **success な submission (= !pending && !error)** を
 * 取り除く。errored submission は残す (= user が clear / retry で操作する)。
 *
 * これにより、derive 楽観 UX で `<For each={subs.value}>` が「server 戻りで自動的に
 * 楽観行が消える」体験を得られる (= ADR 0051 derive 派の核体験)。
 *
 * router.tsx の effect で `_diffMergeAllLayers` 完了直後に呼ぶ。pathname 一致の
 * revalidate のみ対象 (= 別 page navigate は `_clearAllSubmissionState` 経由)。
 */
export function _cleanupSuccessfulSubmissions(routePath: string): void {
  const slot = _registry.get(routePath);
  if (!slot) return;
  slot.active.value = slot.active.value.filter(
    (s) => s.pending.value || s.error.value !== undefined,
  );
}

/**
 * test 用全 flush。registry entry も全削除する (= 同 test runner プロセス内で
 * 古い slot identity が次の test に漏れない)。
 */
export function _resetRegistryForTest(): void {
  _registry.clear();
  _idCounter = 0;
}

/**
 * 新 Submission instance を生成して route slot に push する (router.tsx 経由)。
 *
 * 戻り値:
 *   - `state`: dispatcher が呼ぶ mutator (setPending / setResult / setError / setInput)
 *   - `submission`: array に push 済みの Submission instance (= UI 側で読む)
 *
 * 引数 `body` / `headers` は retry() で再利用するため保持する。FormData は
 * single-use なので、retry が必要な経路では事前に clone するか input record で
 * 再 encode するのが堅実。本実装では (body, headers) をそのまま握って retry で
 * 同一参照を渡す (= toy 段階、user が file upload 系で retry したくなったら
 * input record + encoding から再 encode する path を別途追加する)。
 */
export function _createSubmissionInstance(
  routePath: string,
  input: Record<string, unknown> | undefined,
  body: BodyInit,
  headers: Record<string, string>,
): { state: SubmissionState; submission: Submission<unknown> } {
  const slot = getOrCreateSlot(routePath);
  const id = nextId();

  const valueSig = signal<unknown>(undefined);
  // pending=true で生成 (= 即 in-flight として現れる)。
  const pendingSig = signal(true);
  const errorSig = signal<SubmissionError | undefined>(undefined);
  const inputSig = signal<Record<string, unknown> | undefined>(input);

  const state: SubmissionState = {
    setResult(r) {
      valueSig.value = r;
      errorSig.value = undefined;
    },
    setError(e) {
      errorSig.value = e;
      valueSig.value = undefined;
    },
    setPending(v) {
      pendingSig.value = v;
    },
    setInput(v) {
      inputSig.value = v;
    },
    isPending() {
      return pendingSig.value;
    },
    _value: valueSig,
    _pending: pendingSig,
    _error: errorSig,
    _input: inputSig,
  };

  const submission: Submission<unknown> = {
    id,
    value: valueSig,
    pending: pendingSig,
    error: errorSig,
    input: inputSig,
    retry: async () => {
      if (pendingSig.value) return;
      if (!_dispatcher) {
        console.warn("[vidro/router] retry() called without a mounted Router (no dispatcher).");
        return;
      }
      // 同 input / 同 path で再 submit。state は既存 instance を上書きするだけで、
      // array 内の identity (id) は維持する (= UI の `<For key={s.id}>` が壊れない)。
      pendingSig.value = true;
      errorSig.value = undefined;
      await _dispatcher.dispatch(routePath, state, { body, headers });
    },
    clear: () => {
      slot.active.value = slot.active.value.filter((s) => s.id !== id);
    },
  };

  slot.active.value = [...slot.active.value, submission];
  return { state, submission };
}

// ---- public factories ----

/**
 * 現 route の最新 submission の stable view。
 *
 * ```tsx
 * const sub = submission<typeof action>();
 * <button disabled={sub.pending.value}>Save</button>
 * ```
 *
 * 単発 form (Settings 保存) や「最新の error / value を読みたい」ケース向け。
 * 複数 in-flight を 1 件ずつ操作するなら `submissions()` を使う。
 */
export function submission<A extends AnyAction = AnyAction>(): LatestSubmission<
  Awaited<ReturnType<A>>
> {
  const route = defaultPathname();
  const slot = getOrCreateSlot(route);
  return {
    value: computed(() => {
      const last = slot.active.value[slot.active.value.length - 1];
      return last ? (last.value.value as Awaited<ReturnType<A>> | undefined) : undefined;
    }) as unknown as Signal<Awaited<ReturnType<A>> | undefined>,
    pending: computed(() => {
      const last = slot.active.value[slot.active.value.length - 1];
      return last ? last.pending.value : false;
    }) as unknown as Signal<boolean>,
    error: computed(() => {
      const last = slot.active.value[slot.active.value.length - 1];
      return last ? last.error.value : undefined;
    }) as unknown as Signal<SubmissionError | undefined>,
    input: computed(() => {
      const last = slot.active.value[slot.active.value.length - 1];
      return last ? last.input.value : undefined;
    }) as unknown as Signal<Record<string, unknown> | undefined>,
  };
}

/**
 * 現 route の全 submission instance を array signal で取る。
 *
 * ```tsx
 * const subs = submissions<typeof action>();
 * <For each={subs.value.filter(s => s.input.value?.intent === "create")}>
 *   {(s) => <li class="opacity-50">{String(s.input.value?.title)} (...adding)</li>}
 * </For>
 * ```
 *
 * 複数 in-flight 楽観 UX (like 連打、list add、chat 連投) で全 in-flight を
 * 個別に表示する用途。intent ごとに分けたければ user 側で `filter` する
 * (= fw は intent を特別扱いしない、Hono的透明性)。
 */
export function submissions<A extends AnyAction = AnyAction>(): Signal<
  Submission<Awaited<ReturnType<A>>>[]
> {
  const route = defaultPathname();
  const slot = getOrCreateSlot(route);
  return slot.active as unknown as Signal<Submission<Awaited<ReturnType<A>>>[]>;
}

/**
 * programmatic submit。現 route (or `opts.action`) の action に input を投げる。
 *
 * ```tsx
 * await submit({ intent: "create", title: "foo" });
 * await submit(formData);
 * ```
 *
 * 各呼び出しが新 Submission instance を生成する (= 連打 guard なし、複数 in-flight
 * 自然対応)。SSR / Router 外では no-op + console.warn。
 */
export async function submit(input?: SubmitInput, opts?: SubmitOptions): Promise<void> {
  if (!_dispatcher) {
    console.warn("[vidro/router] submit() called without a mounted Router (no dispatcher).");
    return;
  }
  const path = opts?.action ?? defaultPathname();
  const normalized = normalizeSubmitInput(input);
  const { body, headers } = encodeSubmitBody(input, opts?.encoding);

  const { state } = _createSubmissionInstance(path, normalized, body, headers);
  await _dispatcher.dispatch(path, state, { body, headers });
}

// ---- helpers ----

/**
 * default action path: window.location.pathname。SSR では `"/"` fallback。
 * `submit()` の `opts.action` 未指定時、および `submission()` / `submissions()` の
 * route 解決に使う。
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
 * submission.input 用に submit 入力を `Record<string, unknown>` に正規化。
 * UI は `s.input.value?.title` のように field 単位で読む想定。
 *
 * ルール:
 *   - undefined / null → undefined (= 「入力なし」明示)
 *   - FormData → Object.fromEntries (重複 key は last-wins、File 値はそのまま保持)
 *   - URLSearchParams → Object.fromEntries (重複 key は last-wins)
 *   - plain object → shallow clone (caller の参照を握って後から書き換えられても影響しない)
 *
 * 注意: 重複 key (e.g. `<input name="tag" multiple>`) は last-wins で潰れる。
 * 楽観 preview には toy 段階で十分。production 化時は qs ライブラリで richer decoding。
 */
export function normalizeSubmitInput(
  input: SubmitInput | undefined,
): Record<string, unknown> | undefined {
  if (input == null) return undefined;
  if (input instanceof FormData) {
    return Object.fromEntries(input as unknown as Iterable<[string, FormDataEntryValue]>);
  }
  if (input instanceof URLSearchParams) {
    return Object.fromEntries(input as unknown as Iterable<[string, string]>);
  }
  return { ...input };
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
