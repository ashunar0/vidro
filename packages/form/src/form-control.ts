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

export type FormControlOptions<T> = {
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
   */
  defaultValues?: Partial<T>;
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

export type FormControl<T extends Record<string, unknown>> = {
  /**
   * `<form onSubmit={f.bind(handleSubmit)}>` で渡す handler factory。preventDefault →
   * schema.safeParse → success なら user fn 呼び出し + pending 管理、failure なら per-field
   * error signal 更新。pending 中の double submit は no-op。
   */
  bind(fn: (data: T) => Promise<void> | void): (event: SubmitEvent) => void;
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
  /** 全 field 値 + error + pending をクリア。success navigate 後等に user が明示的に呼ぶ。 */
  reset(): void;
};

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
export function formControl<T extends Record<string, unknown>>(
  opts: FormControlOptions<T>,
): FormControl<T> {
  const { schema, defaultValues } = opts;

  // per-field state を Map で持つ。schema 未知の field でも getXxxSignal で lazy 生成 (=
  // setFieldErrors で server 側追加 field を受けられるよう)。
  const values = new Map<string, Signal<string>>();
  const errors = new Map<string, Signal<string | undefined>>();
  const pending = signal(false);

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

  return {
    bind(fn) {
      return (event: SubmitEvent) => {
        event.preventDefault();
        if (pending.peek()) return;
        const validation = validateAll();
        if (!validation.ok) return;
        pending.value = true;
        // pending を確実に降ろすため finally。Promise chain は handler 側で await
        // されないので void で意図を明示 (= no-floating-promises)。
        void Promise.resolve(fn(validation.data)).finally(() => {
          pending.value = false;
        });
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
      batch(() => {
        for (const [name, msg] of Object.entries(fields)) {
          if (typeof msg === "string") getErrorSignal(name).value = msg;
        }
      });
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
      });
    },
  };
}
