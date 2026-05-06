import { submission } from "@vidro/router";
import { Field } from "../../components/field";
import type { action } from "./server";

// signup form sketch (ADR 0058 + ADR 0059 dogfood)。
//
// ADR 0059 で sub.fieldError signal が直接 access 可能になったので、ad-hoc
// narrowing (`sub.value.value` を `if ("ok" in v && v.ok === false)` で分岐)
// が不要になった。
//
// `<Field>` Presentational kind に切り出し済 (= 3 回繰り返し + ドメイン名 +
// 再利用見込みで 3/3 揃ったため、`project_fw_design_stance` 公式推奨)。

export default function SignupPage() {
  const sub = submission<typeof action>();

  return (
    <div>
      <h2 class="text-xl font-semibold">Sign up</h2>
      <form method="post" class="mt-4 space-y-3">
        <Field name="email" label="Email" type="email" error={sub.fieldError.value?.email} />
        <Field
          name="password"
          label="Password"
          type="password"
          error={sub.fieldError.value?.password}
        />
        <Field
          name="passwordConfirm"
          label="Confirm Password"
          type="password"
          error={sub.fieldError.value?.passwordConfirm}
        />
        <button
          type="submit"
          disabled={sub.pending.value}
          class="rounded bg-blue-500 px-4 py-2 text-white hover:bg-blue-600 disabled:opacity-50"
        >
          {sub.pending.value ? "Creating..." : "Sign up"}
        </button>
      </form>
    </div>
  );
}
