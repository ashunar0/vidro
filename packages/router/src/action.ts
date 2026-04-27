// Phase 3 R-min (Remix-style minimum) の action primitive 公開 API (ADR 0037)。
// loader と同じ場所 (`server.ts`) に export された action 関数を、Web 標準の
// `<form method="post">` 経由で呼び出して結果を signal-like な API で読む。
//
// public:
//   - `submission<typeof action>()` factory: 現在の form submission の lifecycle
//     state (value / pending / error / reset)。global state 1 個 (= per-page、
//     複数 form の per-form state は R-mid 以降)。Resource (ADR 0028) と同形式の
//     signal-like API で揃え、user 認知負荷を下げる
//   - `ActionArgs<R>` 型: action 関数の引数型。LoaderArgs と同じく Routes 経由で
//     route path から params 型を引き当てる
//   - `AnyAction` 型: 制約用の最低条件
//
// internal:
//   - `_setSubmissionPending` / `_setSubmissionResult` / `_setSubmissionError`:
//     router.tsx の form delegation が呼ぶ state mutator (default export を抑え、
//     `_` 接頭辞で internal 意図を示す)
//
// 命名 (`submission()`): React の `useAction` は呼出回数依存の hook 規約に縛られた
// 名前で Vidro の哲学とズレる (ADR 0011 で `useParams` を却下した経緯と同じ)。
// 一方 Remix は内部で "Submission" を form submit lifecycle の概念名として使って
// おり、Vidro factory 命名 (signal / resource / submission) と整合する。

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
 * server 側で serialize された Error 表現。loader と同じ shape (router/server.ts
 * の `SerializedError` と等価)。public type として export する理由は、user が
 * `submission.error.value` を読むときに `error.message` 等を type-safe に触れる
 * ようにするため。
 */
export type SubmissionError = { name: string; message: string; stack?: string };

/**
 * `submission()` factory の戻り値。Resource (ADR 0028) と同形式の signal-like
 * API で揃える (= `.value` access パターン、router 周りの reactive primitive
 * と一貫)。
 */
export type Submission<T> = {
  value: Signal<T | undefined>;
  pending: Signal<boolean>;
  error: Signal<SubmissionError | undefined>;
  reset(): void;
};

// "current submission" の global state。複数 form の per-form state は R-mid 以降
// (= form と submission の binding API を別途用意する)。toy 段階では 1 page に
// 1 form 前提で、最後の submit が表示される動作。
const _submissionResult = signal<unknown>(undefined);
const _submissionPending = signal(false);
const _submissionError = signal<SubmissionError | undefined>(undefined);

/**
 * 現在の form submission の state を読む factory。
 *
 * 使い方:
 * ```tsx
 * import { submission } from "@vidro/router";
 * import type { action } from "./server";
 *
 * const sub = submission<typeof action>();
 * sub.value.value      // server 戻り値 (or undefined if not submitted yet)
 * sub.pending.value    // submit 中フラグ
 * sub.error.value      // server throw / network error (SubmissionError)
 * sub.reset()          // state を初期化
 * ```
 *
 * `<typeof action>` で server 側 action 関数の戻り値型がそのまま降りる
 * (= `Awaited<ReturnType<typeof action>>`)。型貫通が server / client を貫く。
 */
export function submission<A extends AnyAction = AnyAction>(): Submission<Awaited<ReturnType<A>>> {
  return {
    value: _submissionResult as Signal<Awaited<ReturnType<A>> | undefined>,
    pending: _submissionPending,
    error: _submissionError,
    reset() {
      _submissionResult.value = undefined;
      _submissionError.value = undefined;
      _submissionPending.value = false;
    },
  };
}

// --- internal: form delegation (router.tsx) が呼ぶ state mutator ---

/** submit 開始時に pending=true、完了時 pending=false。fetch failure 時も呼ばれる。 */
export const _setSubmissionPending = (v: boolean): void => {
  _submissionPending.value = v;
};

/**
 * router.tsx の form delegation が「連打 / 多重 submit を弾く」用に呼ぶ guard。
 * R-min は global state 1 個なので、in-flight の最中に追加 submit が来ると
 * bootstrapData 上書き + reset() の経路が前 submit の effect と競合する可能性が
 * あり、最初の 1 回だけを通す方針 (R-mid で per-form binding が入った時に再検討)。
 */
export const _isSubmissionPending = (): boolean => _submissionPending.value;

/** action 戻り値 (plain value) を value に格納、error は clear。 */
export const _setSubmissionResult = (r: unknown): void => {
  _submissionResult.value = r;
  _submissionError.value = undefined;
};

/** server throw / network error を error に格納、value は clear。 */
export const _setSubmissionError = (e: SubmissionError): void => {
  _submissionError.value = e;
  _submissionResult.value = undefined;
};
