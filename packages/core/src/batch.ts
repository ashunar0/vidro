import { enterBatch, exitBatch } from "./observer";

/**
 * 複数の Signal 書き込みを 1 回の Effect 実行にまとめる。
 * batch 中は Effect.notify が queue に積まれ、最外の batch が抜けた瞬間に一括 flush される。
 *
 * fn が throw した場合も finally で flush してから例外を再送する。
 * 書き込んだ状態は Signal に残っているため、observer に伝えない方が「画面と state が食い違う」
 * 不整合を生む — 多少 effect が走った結果を観測してから throw が伝わる方が安全。
 */
export function batch<T>(fn: () => T): T {
  enterBatch();
  try {
    return fn();
  } finally {
    exitBatch();
  }
}
