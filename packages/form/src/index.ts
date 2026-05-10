// ADR 0069: opt-in form control primitive。`@vidro/form` を import した時にだけ
// bundle に乗る composite hook、`@vidro/core` の signal/effect を素材に form の
// state machine (= field values + per-field errors + pending flag) を組み立てる。
//
// 哲学:
//   - schema lib agnostic — `safeParse` を持つ duck-type (zod / valibot 等) で受ける
//   - controlled — internal state が single source of truth、reset()/setFieldErrors()
//     から DOM を上書きできる経路は thunk 経由 (Vidro reactive prop) で確保
//   - submission registry を使わない — cross-route POST native、`fetch` を user 関数
//     に委ねる (= submission slot 不整合 (痛み点 1) 構造的に消える)
//   - `.tsx` (両側実行) でのみ動く — `.server.tsx` 内で使うと build error (ADR 0058 整合)
//
// AppRouter mode の island form の主軸として動く。Remix mode の `submission()` とは
// 別軸、両方共存可能 (1 page 内で混ぜないだけ、ADR 0068 + memory `project_form_design_decided`)。

export { formControl } from "./form-control";
// ADR 0076: bind の duck-type 判定を test で直接 verify するため export。@internal、
// user code からの呼び出しは想定外 (= bind が自動で消化するので普通は呼ぶ理由がない)。
export { isServerFnValidationError } from "./form-control";
export type {
  FormControl,
  FormControlOptions,
  FormControlBindProps,
  FormFieldProps,
  ParseSchema,
  SafeParseResult,
} from "./form-control";
