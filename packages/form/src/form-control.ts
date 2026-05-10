import { signal, batch, type Signal } from "@vidro/core";

/**
 * schema lib agnostic な safeParse 互換 interface。zod / valibot / yup / ArkType 等、
 * `safeParse(input): {success, data} | {success: false, error.issues[]}` を持つ lib
 * なら全部入る。issue の path は `PropertyKey` で受ける (= zod 4 が `symbol` を含む
 * のと整合)、実装側は string segment だけを field name として扱い、それ以外は無視。
 */
export type SafeParseResult<T> =
  | { success: true; data: T }
  | {
      success: false;
      error: {
        issues: ReadonlyArray<{ readonly path: ReadonlyArray<PropertyKey>; message: string }>;
      };
    };

export interface ParseSchema<T> {
  safeParse(input: unknown): SafeParseResult<T>;
}

/**
 * ADR 0078: source data D と schema 推論 T の field overlap を要求する制約。
 *
 *   - `keyof D extends never` (= D が `{}` 等 empty object) → 制約スキップで D を返す
 *     (= `defaultValues: {}` の明示渡しを許可、reject すると意味のない strictness)
 *   - `(keyof D & keyof T) extends never` (= source に schema field が 1 個も存在しない)
 *     → `never` を要求して build error 化 (= typo 単独 / 全 field rename 検出)
 *   - それ以外 (= 1 field 以上 overlap) → そのまま D を返す (= post まるごと OK、
 *     partial OK)
 *
 * `defaultValues` 省略時は generic D が default `Partial<T>` で固定されるので
 * `keyof D = keyof T` で第 2 枝の overlap check を pass する (= 第 1 枝には入らない、
 * 結果は同じく pass)。
 *
 * partial rename (= 1 field だけ rename、もう 1 field は match) は overlap が残るので
 * 検出限界 (= 案 C = 親 → 子 props vertical 型貫通の領域、本 ADR scope 外)。
 */
type ValidDefaults<T, D> = keyof D extends never ? D : keyof D & keyof T extends never ? never : D;

export type FormControlOptions<T, D extends Partial<T> = Partial<T>> = {
  schema: ParseSchema<T>;
  /**
   * 初期値の seed。edit form (= prefill 必要) で必須。例: `{ title: post.title }`。
   * 渡された field は createControl 時点で signal value に流し込まれ、SSR で
   * spread される `value=` thunk が prefill 値を吐くので、hydrate 後も保持される。
   * 渡されない field は空文字列スタート (= create form の default 動作と同じ)。
   *
   * 値は string 系 (= input/textarea の DOM value 型) のみ意味があるが、TS 上は
   * `Partial<T>` で受けて非 string は string 化する (= number 1 → "1" 等)。
   * non-string 値の defaultValues は ADR 0069 範囲外、formControl は string DOM
   * value のみ扱う規約。
   *
   * ADR 0078: source data の型 D を generic で infer して `ValidDefaults<T, D>` で
   * 「schema field と 1 個でも overlap してるか」を build 時 check。typo 単独
   * (= `{ titlee: "x" }`) と全 field rename を build error 化、`post` (= Post 型
   * まるごと、第 12 周目規約) は title/body overlap で素通り。
   */
  defaultValues?: ValidDefaults<T, D>;
};

/**
 * `f.field("title")` の戻り。`<input {...f.field("title")} />` で spread して使う。
 * value は thunk (= Vidro reactive prop)、reset() / setFieldErrors() で internal
 * state を変えると spread 経由で DOM に伝播する。
 */
export type FormFieldProps<K extends string> = {
  name: K;
  value: () => string;
  onInput: (event: Event) => void;
  onBlur: () => void;
};

/**
 * `f.bind(fn)` の戻り値 (= ADR 0075 で導入)。`<form {...f.bind(handler)}>` の spread
 * 経路で、submit handler と router intercept escape marker を 1 度に注入する。
 *
 * - `onSubmit`: preventDefault → schema.safeParse → user fn 呼出 + pending 管理
 * - `data-vidro-no-intercept`: router の global form interceptor (ADR 0051) から
 *   逃げる marker。formControl で fetch を直接呼ぶ island form は SPA 遷移経路に
 *   流したくないので、必ず付ける必要がある (= 旧形式は user 手書き、ADR 0075 で
 *   formControl が自動注入する形に変更)
 */
export type FormControlBindProps = {
  onSubmit: (event: SubmitEvent) => void;
  "data-vidro-no-intercept": "";
};

/**
 * ADR 0077: `f.bind(handler, options)` の第 2 引数。`onError` で「ADR 0076 の自動 catch
 * (= validation error) で消化されなかった error」を user 経路に渡す hook。
 *
 * `<form {...f.bind(handler, { onError: (err) => f.setFormError(err.message) })}>` で
 * form-level error UI に流すのが典型 use case。`onError` を渡さない場合は従来通り
 * 再 throw されて unhandled rejection 経路 (= JS 標準、global handler / devtools console
 * が拾う) に落ちる、既存挙動と互換。
 *
 * 業界 trend (= Conform / TanStack Form / React 19 useActionState / Remix useActionData
 * 等) は「server-side error の自動消化 + user hook で flexibility」方向、本 option は
 * その路線を formControl primitive 内で完結させる設計。
 */
export type FormControlBindOptions = {
  /**
   * `bind` 内部 catch chain で validation error 以外の error が出た場合に呼ばれる。
   * 渡されない場合は再 throw されて unhandled rejection 経路に落ちる (= 既存挙動)。
   * `f.setFormError(err.message)` で form-level UI に流すのが典型、business decision
   * (= retry / redirect / Sentry 通知 / ignore 等) は user の onError 内で書き分ける。
   *
   * 注: `onError` 内で sync throw すると、その error は機構が再 catch せず unhandled
   * rejection になる (= 2 重に出る経路はないが、`onError` の責務は「副作用で UI / log
   * 系に流す」までで、business 判断の throw は不向き)。
   */
  onError?: (err: unknown) => void;
};

export type FormControl<T extends Record<string, unknown>> = {
  /**
   * `<form {...f.bind(handleSubmit)}>` で渡す form props factory (ADR 0075)。
   * 戻り値は `{ onSubmit, "data-vidro-no-intercept": "" }` で、JSX spread 経由で
   * form node に注入する。preventDefault → schema.safeParse → success なら user fn
   * 呼出 + pending 管理、failure なら per-field error signal 更新。pending 中の
   * double submit は no-op。
   *
   * marker (= `data-vidro-no-intercept`) は router の global form interceptor
   * (ADR 0051) から逃げる escape hatch。formControl で fetch を直叩きする island
   * form は SPA 遷移経路に乗せたくないので必須、formControl 内で隠蔽する。
   *
   * ADR 0077: 第 2 引数 `options.onError` で「ADR 0076 自動 catch で消化されなかった
   * error」を user に渡す hook。`onError` を渡さない場合は従来通り再 throw → unhandled
   * rejection (= 既存挙動)、user code は無改修で OK。
   */
  bind(
    fn: (data: T) => Promise<void> | void,
    options?: FormControlBindOptions,
  ): FormControlBindProps;
  /**
   * field props を返す。spread して `<input>` に渡す形を想定。type は schema の keyof T
   * で絞られているので、schema にない field 名は build error (型貫通 #4)。
   */
  field<K extends keyof T & string>(name: K): FormFieldProps<K>;
  /** per-field error signal、`{f.error("title").value && <p>...</p>}` で reactive 表示。 */
  error<K extends keyof T & string>(name: K): Signal<string | undefined>;
  /** submit 中フラグ、button disabled / "Submitting..." 表示用。 */
  pending: Signal<boolean>;
  /**
   * server 戻り 422 の `{fields: {...}}` を field error に流す。client schema を passes
   * したが server side validation で fail (= unique constraint 違反等) のケース。
   */
  setFieldErrors(fields: Partial<Record<keyof T & string, string>>): void;
  /**
   * ADR 0077: form-level error signal (= rhf `formState.errors.root` 相当)。
   * network error / 500 / business error 等、per-field に紐付かない error 表示用。
   * `<form>` 直下に `{f.formError.value && <p>{f.formError.value}</p>}` で reactive 表示。
   * bind 内部の自動 catch chain (= ADR 0076) は touch しない (= validation だけ自動、
   * その他 error は user の try/catch で setFormError 呼ぶ手動経路、business decision
   * 余地を保つ)。
   */
  formError: Signal<string | undefined>;
  /**
   * ADR 0077: form-level error を手動 set。`undefined` 渡しで clear。
   * `f.reset()` でも自動 clear される (= per-field error / values と一貫)。
   * 値は string only (= `Error` 渡しは user 側で `err.message` 取って渡す、型単純化)。
   */
  setFormError(message: string | undefined): void;
  /** 全 field 値 + error + pending + formError をクリア。success navigate 後等に user が明示的に呼ぶ。 */
  reset(): void;
};

/**
 * ADR 0076: `@vidro/router/client` の `ServerFnValidationError` を duck-type で判定する。
 *
 * 直接 import せず `err.name === "ServerFnValidationError"` で見るのは:
 *   1. `@vidro/form` (= +pack tier) → `@vidro/router` (= +router tier) の peer dep を
 *      避けて 3-tier 構造を維持するため (memory `project_3tier_architecture`)
 *   2. cross-bundle で `instanceof` が壊れる事象 (= HMR / package re-pack 中に class が
 *      複数 instance 化、memory `feedback_dev_restart_after_dist_change`) を構造的に
 *      回避するため
 *   3. `Error.name` で error を discriminate するのは `DOMException`/`SyntaxError` 等が
 *      踏んでる古典 JS 規約、Vidro 独自規約ではない
 *
 * `ServerFnValidationError.name === "ServerFnValidationError"` は ADR 0076 で固定された
 * public contract。`@vidro/router/client` 側で name を変えると本判定が break する。
 *
 * @internal — public API ではないが、duck-type 判定の責務を test で直接 verify するため
 * export している。user code から直接呼ぶことは想定していない (= bind の自動 catch 経由)。
 */
export function isServerFnValidationError(
  err: unknown,
): err is { name: "ServerFnValidationError"; fields: Record<string, string> } {
  if (!(err instanceof Error)) return false;
  if (err.name !== "ServerFnValidationError") return false;
  if (!("fields" in err)) return false;
  const fields = (err as { fields: unknown }).fields;
  return typeof fields === "object" && fields !== null;
}

/**
 * ADR 0069 §Decision: `formControl({ schema })` で client form の state machine を作る。
 *
 * 内部実装:
 *   - per-field value signal (= controlled、reset/setFieldErrors 起点で DOM に伝播)
 *   - per-field error signal (= per-field reactive 表示、Show 不要、痛み点 4 解消)
 *   - pending signal (= submit 中フラグ)
 *
 * validation timing (ADR 0069 §論点 3):
 *   - submit: 全 field validate、blocking error あれば user fn 呼ばない
 *   - blur: 該当 field のみ validate (= 業界標準 UX、過剰表示しない)
 *   - input (error 表示中のみ): 該当 field 再 validate (= once-errored becomes reactive)
 */
export function formControl<T extends Record<string, unknown>, D extends Partial<T> = Partial<T>>(
  opts: FormControlOptions<T, D>,
): FormControl<T> {
  const { schema, defaultValues } = opts;

  // per-field state を Map で持つ。schema 未知の field でも getXxxSignal で lazy 生成 (=
  // setFieldErrors で server 側追加 field を受けられるよう)。
  const values = new Map<string, Signal<string>>();
  const errors = new Map<string, Signal<string | undefined>>();
  const pending = signal(false);
  // ADR 0077: form-level error signal。network/500/business error 等、per-field
  // に紐付かない error を user の try/catch + setFormError 経由で表示するための
  // reactive primitive。bind 内部の自動 catch chain は変更なし、自動流入は無し。
  const formError = signal<string | undefined>(undefined);

  // defaultValues seed: edit form の prefill 経路 (2026-05-10、61st session)。
  // 与えられた field を eager に signal 初期化して、`f.field(name).value()` thunk が
  // 最初から prefill 文字列を返すようにする。SSR/hydrate 両側で同じ値が出るので
  // hydrate 時の DOM 上書きで空に戻る事象 (= dogfood 第 4 周目で踏んだ痛み) を消す。
  if (defaultValues) {
    for (const [name, val] of Object.entries(defaultValues)) {
      if (val === undefined || val === null) continue;
      values.set(name, signal<string>(String(val)));
    }
  }

  function getValueSignal(name: string): Signal<string> {
    let s = values.get(name);
    if (!s) {
      s = signal<string>("");
      values.set(name, s);
    }
    return s;
  }

  function getErrorSignal(name: string): Signal<string | undefined> {
    let s = errors.get(name);
    if (!s) {
      s = signal<string | undefined>(undefined);
      errors.set(name, s);
    }
    return s;
  }

  function snapshotValues(): Record<string, unknown> {
    const obj: Record<string, unknown> = {};
    for (const [name, sig] of values.entries()) obj[name] = sig.peek();
    return obj;
  }

  /** 全 field validate、結果に基づいて per-field error signal を total 更新する。 */
  function validateAll(): { ok: true; data: T } | { ok: false } {
    const result = schema.safeParse(snapshotValues());
    if (result.success) {
      batch(() => {
        for (const sig of errors.values()) sig.value = undefined;
      });
      return { ok: true, data: result.data };
    }
    // schema fail: issue を field 単位に集約 (= 同 field 複数 issue は最初を採用)
    const fieldErrors = new Map<string, string>();
    for (const issue of result.error.issues) {
      const path = issue.path[0];
      if (typeof path !== "string") continue;
      if (!fieldErrors.has(path)) fieldErrors.set(path, issue.message);
    }
    batch(() => {
      // 既存 field 全部 sweep (= 解消した error は undefined に倒す)
      for (const [name, sig] of errors.entries()) {
        sig.value = fieldErrors.get(name);
      }
      // 新規 field の error を生やす
      for (const [name, msg] of fieldErrors.entries()) {
        if (!errors.has(name)) getErrorSignal(name).value = msg;
      }
    });
    return { ok: false };
  }

  /** 単一 field の error だけ更新する (= blur / input 時)。他 field は触らない。 */
  function validateField(name: string): void {
    const result = schema.safeParse(snapshotValues());
    if (result.success) {
      getErrorSignal(name).value = undefined;
      return;
    }
    const issue = result.error.issues.find((i) => i.path[0] === name);
    getErrorSignal(name).value = issue?.message;
  }

  // server 戻り {fields} を field error に流す共通実装。返り値の setFieldErrors
  // (= public method) と bind の自動 catch 経路 (ADR 0076) で共有する。
  function applyFieldErrors(fields: Partial<Record<string, string>>): void {
    batch(() => {
      for (const [name, msg] of Object.entries(fields)) {
        if (typeof msg === "string") getErrorSignal(name).value = msg;
      }
    });
  }

  return {
    bind(fn, options): FormControlBindProps {
      // ADR 0075: 戻り値は form props object (= JSX spread 用)。onSubmit handler
      // と router intercept escape marker を同時に注入する。
      return {
        onSubmit: (event: SubmitEvent) => {
          event.preventDefault();
          if (pending.peek()) return;
          const validation = validateAll();
          if (!validation.ok) return;
          pending.value = true;
          // ADR 0076: handler が ServerFnValidationError 形 (= name + fields shape)
          // を throw したら自動で setFieldErrors に流す。それ以外の error は ADR 0077
          // の onError option があれば user に渡す、無ければ bubble up (= unhandled
          // rejection、JS 標準挙動)。duck-type 判定で `@vidro/router/client` への peer
          // dep を避け、cross-bundle で `instanceof` が壊れる事象 (memory
          // feedback_dev_restart_after_dist_change) も構造的に回避する。pending を確実
          // に降ろすため finally、Promise chain は handler 側で await されないので void
          // で意図を明示 (= no-floating-promises)。
          //
          // try/catch で sync throw を Promise.reject に変換: 素朴な `Promise.resolve(fn(...))`
          // は fn の同期評価で throw した瞬間に呼出元 (= onSubmit) で uncaught に流れて
          // catch chain に入らない。fn 自体は同期評価したい (= 既存 test の「pending true 確認
          // 直後に handler 内代入が見える」順序を維持) ので、`Promise.resolve().then()` 形
          // でなく try/catch wrap が正解。
          let promise: Promise<unknown>;
          try {
            promise = Promise.resolve(fn(validation.data));
          } catch (err) {
            promise = Promise.reject(err);
          }
          void promise
            .catch((err: unknown) => {
              if (isServerFnValidationError(err)) {
                applyFieldErrors(err.fields);
                return;
              }
              // ADR 0077: validation 以外の error を user の onError hook に渡す。user
              // が `f.setFormError(...)` で form-level UI に流すのが典型。onError を渡さ
              // ない場合は従来通り再 throw → unhandled rejection (= 既存挙動と互換)。
              if (options?.onError) {
                options.onError(err);
                return;
              }
              throw err;
            })
            .finally(() => {
              pending.value = false;
            });
        },
        "data-vidro-no-intercept": "",
      };
    },
    field<K extends keyof T & string>(name: K): FormFieldProps<K> {
      const valueSig = getValueSignal(name);
      const errorSig = getErrorSignal(name);
      return {
        name,
        // thunk を返すことで Vidro reactive prop として spread 経由で DOM に bind される。
        // valueSig が更新されると input の value 属性も更新される (= controlled)。
        value: () => valueSig.value,
        onInput: (event) => {
          const target = event.currentTarget as
            | HTMLInputElement
            | HTMLTextAreaElement
            | HTMLSelectElement
            | null;
          if (!target) return;
          valueSig.value = target.value;
          // 既に error 表示中の field のみ再 validate (= once-errored becomes reactive)
          if (errorSig.peek() !== undefined) validateField(name);
        },
        onBlur: () => validateField(name),
      };
    },
    error<K extends keyof T & string>(name: K): Signal<string | undefined> {
      return getErrorSignal(name);
    },
    pending,
    setFieldErrors(fields) {
      applyFieldErrors(fields);
    },
    formError,
    setFormError(message) {
      // ADR 0077: 単純 set。`undefined` 渡しで clear、reactive 表示が自動更新。
      // batch 不要 (= 1 signal 単独 write、他 signal と coalesce 必要なし)。
      formError.value = message;
    },
    reset() {
      batch(() => {
        // defaultValues 与えられてればそこに戻す (= edit form の「変更を破棄」操作)、
        // 与えられてなければ全 field 空文字列 (= create form の通常 reset)。
        for (const [name, sig] of values.entries()) {
          const def = defaultValues?.[name as keyof T];
          sig.value = def === undefined || def === null ? "" : String(def);
        }
        for (const sig of errors.values()) sig.value = undefined;
        pending.value = false;
        // ADR 0077: form-level error も reset で undefined に戻す (= per-field
        // error / values と一貫、user が手動 clear する手間を消す)。
        formError.value = undefined;
      });
    },
  };
}
