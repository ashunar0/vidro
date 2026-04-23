import { getCurrentOwner, Owner } from "./owner";

// mount() が target に DOM を attach した直後、一度だけ呼ばれる fn を貯める global queue。
// onMount(fn) は mount() scope の中で呼ばれた時のみ push される (scope 外は warn)。
// 発火タイミングの決定は docs/decisions/0002-on-mount.md 参照。
// 各エントリには呼び出し時の Owner も保存する — flush 時にそれぞれの Owner scope で
// fn を走らせ、throw を nearest ErrorBoundary に届けるため。

type PendingMount = {
  fn: () => void;
  owner: Owner | null;
};

let insideMount = false;
const pendingMounts: PendingMount[] = [];

/**
 * mount() scope 内で呼ばれた時だけ fn を queue に積む。scope 外では warn して no-op。
 * fn は mount() の appendChild 直後、同期で一度だけ呼ばれる (依存追跡なし)。
 */
export function onMount(fn: () => void): void {
  if (!insideMount) {
    // toy 段階は dev warn で気づきやすさ優先。production build で剥がす分岐は未実装。
    // eslint-disable-next-line no-console
    console.warn("[vidro] onMount called outside of a mount() scope — ignored.");
    return;
  }
  pendingMounts.push({ fn, owner: getCurrentOwner() });
}

/** run の間 insideMount=true にして、onMount(fn) の enqueue を受け入れる。ネスト対応のため前値を復元する。 */
export function runWithMountScope<T>(run: () => T): T {
  const wasInside = insideMount;
  insideMount = true;
  try {
    return run();
  } finally {
    insideMount = wasInside;
  }
}

/** queue に溜まった fn を登録順に同期実行する。各 fn は呼び出し時の Owner scope で走らせ、
 *  throw は nearest ErrorBoundary の handler に流す (handler 無しなら Owner の root で再 throw)。 */
export function flushMountQueue(): void {
  if (pendingMounts.length === 0) return;
  // 走らせる前に snapshot + clear。fn 内で新たに onMount が呼ばれた場合 (scope 外なので warn)
  // や次回の mount() に残り物が見えないようにする。
  const toRun = pendingMounts.slice();
  pendingMounts.length = 0;
  for (const { fn, owner } of toRun) {
    if (owner) owner.runCatching(fn);
    else fn();
  }
}
