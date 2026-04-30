import { Signal, signal } from "./signal";

// ADR 0047 path F: deep reactive container。leaf (primitive) は Signal で自動 wrap、
// 中間階層 (object / array) は透明 proxy で連鎖させる。
// 読み: `data.notes[0].title.value` のように末端の `.value` で raw を取り出す
// 書き: 既存 leaf には `.value =`、object/array の field には直接代入 (Proxy.set)
// destructure 罠: leaf は signal なので `const { title } = note` で signal が取れて reactivity 維持される

/** primitive 判定。null も「箱に入らない値」として primitive 扱い。 */
function isPrimitive(value: unknown): boolean {
  return value === null || (typeof value !== "object" && typeof value !== "function");
}

/** raw object/array → 同じ proxy を返すためのキャッシュ。同じ raw を 2 回 wrap しないように。 */
const proxyCache = new WeakMap<object, object>();

/** 既に proxy 化済かを判定する内部マーカー。 */
const STORE_RAW = Symbol("vidro.store.raw");

/** Store<T> の概念型。
 *  - primitive → Signal<T>
 *  - array<U>   → Array<Store<U>> (proxy で wrap)
 *  - object     → 各 field を Store で wrap した object
 *  ※ TypeScript の型として完全な再帰 wrap を表現するのは難しい (= depth 制限 / circular ref)。
 *     ここでは「user 視点で見える形」を表現する。runtime は別途 proxy で動く。 */
type Primitive = string | number | boolean | bigint | symbol | null | undefined;

export type Store<T> = T extends Primitive
  ? Signal<T>
  : T extends Array<infer U>
    ? Array<Store<U>>
    : T extends object
      ? { [K in keyof T]: Store<T[K]> }
      : T;

/** 値を再帰的に wrap する。primitive → Signal、object → ObjectProxy、array → ArrayProxy。 */
function wrap(value: unknown): unknown {
  if (isPrimitive(value)) return signal(value as Primitive);
  // 既に Signal なら 2 重 wrap しない (= user が `data.x = signal(5)` 等で渡した場合の保護)
  if (value instanceof Signal) return value;
  // 既に proxy 化済 (= 2 重 wrap 回避)
  if ((value as { [STORE_RAW]?: unknown })[STORE_RAW] !== undefined) return value;
  if (Array.isArray(value)) return createArrayProxy(value);
  return createObjectProxy(value as object);
}

// 変更系 (mutating) 配列メソッド: 引数を wrap して storage に流す + length signal を notify
const MUTATING_METHODS = new Set([
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "sort",
  "reverse",
  "fill",
  "copyWithin",
]);

function createObjectProxy(target: object): object {
  const cached = proxyCache.get(target);
  if (cached) return cached;

  // target を直接 mutate して各 field を wrap 済みの値に置き換える。
  // これで Proxy invariants (= proxy.get と target の property descriptor の整合) が自動で満たされる。
  // 副作用: 元の raw object が破壊される。これは Vidro の規約として user に伝える
  // (= raw は store 化したら捨てる、Vue 3 reactive と同じ流儀)。
  for (const key of Reflect.ownKeys(target)) {
    Reflect.set(target, key, wrap(Reflect.get(target, key)));
  }

  // structural change (key 追加/削除) を観測する Signal。`for...in` / `Object.keys` 等の
  // iteration の reactivity を担保する。
  const keysVersion = signal(0);

  const proxy = new Proxy(target, {
    get(t, key, receiver) {
      if (key === STORE_RAW) return t;
      return Reflect.get(t, key, receiver);
    },
    set(t, key, value, receiver) {
      const had = Reflect.has(t, key);
      const existing = Reflect.get(t, key, receiver);
      // 既存 leaf signal に primitive を書く → .value 経由で reactive 更新
      if (existing instanceof Signal && isPrimitive(value)) {
        existing.value = value;
        return true;
      }
      // それ以外: 新 store で置き換え (= primitive ↔ object の型変化 / 動的 field 追加)
      const result = Reflect.set(t, key, wrap(value), receiver);
      if (!had) keysVersion.value++;
      return result;
    },
    deleteProperty(t, key) {
      if (!Reflect.has(t, key)) return true;
      const result = Reflect.deleteProperty(t, key);
      keysVersion.value++;
      return result;
    },
    has(t, key) {
      void keysVersion.value;
      return Reflect.has(t, key);
    },
    ownKeys(t) {
      void keysVersion.value;
      return Reflect.ownKeys(t);
    },
  });

  proxyCache.set(target, proxy);
  return proxy;
}

function createArrayProxy(target: unknown[]): unknown[] {
  const cached = proxyCache.get(target);
  if (cached) return cached as unknown[];

  // 各要素を wrap して target に書き戻す
  for (let i = 0; i < target.length; i++) {
    target[i] = wrap(target[i]);
  }

  // 配列の structural change (length / 要素追加削除) を観測する Signal
  const lengthSignal = signal(target.length);

  const proxy = new Proxy(target, {
    get(t, key, receiver) {
      if (key === STORE_RAW) return t;
      if (key === "length") return lengthSignal.value;
      // 変更系メソッドを wrap (= 引数を wrap + length notify)
      if (typeof key === "string" && MUTATING_METHODS.has(key)) {
        return wrapMutatingMethod(t, lengthSignal, key);
      }
      // それ以外のメソッド (find/filter/map/forEach/...) は length を track して透過
      const value = Reflect.get(t, key, receiver);
      if (typeof value === "function") {
        return function (this: unknown, ...args: unknown[]): unknown {
          // length を track することで「配列を iterate する effect」が
          // 構造変化で再実行される。要素自体の変化は要素 (signal/proxy) 側の
          // track で拾われる。
          void lengthSignal.value;
          // biome-ignore lint/complexity/noUselessThisAlias: native method needs the array as `this`
          const arrayThis = this === proxy ? t : this;
          return Reflect.apply(value, arrayThis, args);
        };
      }
      return value;
    },
    set(t, key, value, receiver) {
      // 配列インデックス書き換え
      if (typeof key === "string") {
        const idx = Number(key);
        if (Number.isInteger(idx) && idx >= 0) {
          const existing = Reflect.get(t, key, receiver);
          if (existing instanceof Signal && isPrimitive(value)) {
            existing.value = value;
            return true;
          }
          const had = idx < t.length;
          const result = Reflect.set(t, key, wrap(value), receiver);
          if (!had) lengthSignal.value = t.length;
          return result;
        }
      }
      // length 直書き (= 配列の切り詰め)
      if (key === "length" && typeof value === "number") {
        const result = Reflect.set(t, key, value, receiver);
        lengthSignal.value = value;
        return result;
      }
      return Reflect.set(t, key, value, receiver);
    },
    deleteProperty(t, key) {
      const result = Reflect.deleteProperty(t, key);
      lengthSignal.value = t.length;
      return result;
    },
    has(t, key) {
      return Reflect.has(t, key);
    },
    ownKeys(t) {
      void lengthSignal.value;
      return Reflect.ownKeys(t);
    },
  });

  proxyCache.set(target, proxy);
  return proxy;
}

/** push / splice / pop 等の mutating method を wrap。引数を wrap してから storage を mutate し、length を notify。 */
function wrapMutatingMethod(
  target: unknown[],
  lengthSignal: Signal<number>,
  method: string,
): (...args: unknown[]) => unknown {
  return function (...args: unknown[]): unknown {
    let result: unknown;
    switch (method) {
      case "push":
      case "unshift": {
        const wrapped = args.map(wrap);
        result = (target as unknown as Record<string, (...a: unknown[]) => unknown>)[method](
          ...wrapped,
        );
        break;
      }
      case "splice": {
        const [start, deleteCount, ...items] = args as [number, number, ...unknown[]];
        const wrappedItems = items.map(wrap);
        // splice の戻り値 (削除された要素) は wrap されたまま返す
        result = target.splice(start, deleteCount, ...wrappedItems);
        break;
      }
      default: {
        // pop / shift / sort / reverse / fill / copyWithin は引数の wrap 不要。
        // 注意: sort / reverse の compareFn / mapFn には Signal や proxy が要素として渡る
        // ため、user が compareFn を書く時は `(a, b) => a.value - b.value` のように
        // `.value` 経由で読む必要がある (= signal triad の規約に従う)。
        result = (target as unknown as Record<string, (...a: unknown[]) => unknown>)[method](
          ...args,
        );
      }
    }
    lengthSignal.value = target.length;
    return result;
  };
}

/** factory 形式の生成 API。primitive を渡すと Signal、object/array を渡すと proxy が返る。 */
export function store<T>(initial: T): Store<T> {
  return wrap(initial) as Store<T>;
}

/** ADR 0050: 引数が既に Signal なら型エラーにするための guard。
 *  「plain JSON-like value のみを Store に昇格する」という usage convention を型で強制する。
 *  既存 Store (= 中間 proxy) は structural には plain object と区別が付かないため弾けないが、
 *  少なくとも leaf Signal は弾ける。B 拡張 (= union で Store<E> も受ける) になったら緩める。 */
type NotSignal<T> = T extends Signal<unknown> ? never : T;

/** ADR 0050: plain JSON-like value を Store<T> に昇格する公開 API。
 *  `store()` と内部実装 (= `wrap`) を共有するが、usage convention が違う:
 *  - `store(plain)` = page-local state の起点宣言 (= primitive declaration)
 *  - `signalify(plain)` = 既存 Store に append する一時 value の昇格 (= utility)
 *  例: `data.notes.push(signalify({ id: -1, title }))`
 *
 *  引数は Signal 自体を受け付けない (= 型エラー)。runtime は `wrap` 内で defensive に
 *  passthrough するが、API contract としては「plain を Store にする」専用。 */
export function signalify<T>(value: NotSignal<T>): Store<T> {
  return wrap(value) as Store<T>;
}
