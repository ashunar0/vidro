// @vidro/hibana/Form — Step 5 follow-up (ADR 0082) の form 版 opt-in component。
//
// ADR 0080 `<Link>` の sibling。`<form>` に `data-hibana-form` marker を付けるだけの
// 軽量 component。client navigation runtime (= Phase 2 で実装) が `[data-hibana-form]`
// submit を intercept して fetch + partial swap で SPA 風 submit を発火する。
//
// 書き忘れて素の `<form method="POST">` で書いた場合は graceful degradation で
// MPA 動作 (= full page reload) する。JS 切れ + 5xx + Frame 不在も同じく fallback。
//
// method について:
//   HTML form の native method 属性は POST/GET しか browser が解釈しない。
//   PUT/DELETE/PATCH を渡しても browser は GET にフォールバックする。
//   JS あり経路では fetch で任意 method 可能なので、SSR では `method="POST"` に倒し、
//   実 method を `data-hibana-method` attr で別途持たせる。JS 切れ時の non-POST 対応は
//   v1 で skip (= ADR 0082 Trade-off)。dogfood は POST + 別 URL (= Rails 流) で完走済。
//
// ADR: docs/decisions/0082-hibana-form-submit-navigation.md

import { h } from "@vidro/core";

export type FormMethod = "POST" | "PUT" | "DELETE" | "PATCH";

export type FormProps = {
  method: FormMethod;
  action: string;
  children?: unknown;
  // 標準 <form> attrs を pass-through (= encType / target / autoComplete / class 等)。
  // ADR 0082 API shape 参照、Link/Frame と違って submit 時の native attribute を user が
  // 細かく制御する場面が多いので open object 形にしている。
  [key: string]: unknown;
};

export const Form = (props: FormProps): Node => {
  const { method, action, children, ...rest } = props;
  warnInDev(method, action);
  return h(
    "form",
    {
      ...rest,
      // JS 切れ時の素 form submit は POST に倒す (= 上記 method 注釈参照)。
      // JS あり経路は client runtime が data-hibana-method を読んで fetch 経由で実 method 送る。
      method: "POST",
      action,
      "data-hibana-form": "",
      "data-hibana-method": method,
    },
    children,
  );
};

// dev only の最小 runtime warn。FormProps の TS required で書き忘れは大半が compile error に
// なるが、any cast / 動的 props 経路で type bypass された case を最後の砦としてここで拾う。
// prod では process.env を経由しないので vite plugin の dead code elimination で消える想定。
const warnInDev = (method: unknown, action: unknown): void => {
  if (typeof process === "undefined" || process.env.NODE_ENV !== "development") return;
  if (typeof action !== "string" || action.length === 0) {
    console.warn(
      "[hibana] <Form> action attribute is missing or empty. " +
        "Submit target is ambiguous, fetch intercept will fail. ADR 0082 §API shape 参照。",
    );
  }
  // GET は型 union で除外してあるが、type bypass された場合の保険として警告。
  // GET なら <Link> を使う方が ADR 0080 と整合 (= form submit ではなく navigation 扱い)。
  if (method === "GET") {
    console.warn(
      '[hibana] <Form method="GET"> は <Link> 推奨。GET form は browser default で URL に ' +
        "query 化されるため、partial swap の wire 仕様 (= request body) と不整合。",
    );
  }
};
