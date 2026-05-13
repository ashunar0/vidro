import { Signal } from "./signal";
import { effect } from "./effect";
import { untrack } from "./observer";
import { flushMountQueue, runWithMountScope } from "./mount-queue";
import { Owner } from "./owner";
import { Ref } from "./ref";
import { getRenderer } from "./renderer";
import { getCurrentAsyncScope } from "./async-scope";
import type { VAsyncSlot, VNode } from "./server-renderer";

/** Fragment marker: `<>...</>` / `h(Fragment, null, ...)` で children をグループ化する。 */
export const Fragment = Symbol("Fragment");

// ADR 0066 Phase 2: async function component (= server-only) を許容するため
// `Node | Promise<Node>` に拡張。client mode で Promise を返した場合は h() の
// runtime guard で throw する (Q2 確定形 message)。
type ComponentFn = (props: Record<string, unknown>) => Node | Promise<Node>;

/**
 * JSX 要素を Renderer 経由で構築する。type が文字列なら IntrinsicElement、関数なら
 * Component (new child Owner の中で 1 回だけ呼ぶ)、Fragment なら fragment ノードを返す。
 * DOM 依存はすべて getRenderer() 経由 (ADR 0016)。
 */
export function h(
  type: string | ComponentFn | typeof Fragment,
  props: Record<string, unknown> | null,
  ...children: unknown[]
): Node {
  const r = getRenderer();

  if (type === Fragment) {
    const frag = r.createFragment();
    for (const child of children) appendChild(frag, child);
    return frag;
  }

  if (typeof type === "function") {
    const resolvedProps: Record<string, unknown> = props ?? {};
    // children を props.children に合流させる (1 件なら unwrap、それ以外は配列のまま)
    if (children.length === 1) resolvedProps.children = children[0];
    else if (children.length > 1) resolvedProps.children = children;
    // A 方式の `{expr}` → `() => expr` 変換を component 境界でも貫くため、props を
    // Proxy でラップして「読むたびに関数を評価」する。これで intrinsic 同様に
    // reactive props (`count={signal.value}` → 読むたびに current value) が動く。
    // 例外: `on*` は event handler、`children` は render callback / Node / 多態
    // を渡すスロットなので素通し。destructure すると getter が 1 度しか走らず
    // reactivity が死ぬので使い手は `const x = props.foo` 的な個別参照を使う。
    const propsProxy = wrapComponentProps(resolvedProps);
    // component は独立した child Owner の中で 1 回だけ評価する (invoke-once)。
    // runCatching で囲んで、component 関数内の throw を nearest ErrorBoundary に届ける。
    // 例外で undefined が返ったら placeholder Comment を返す — ErrorBoundary があれば
    // その effect が fallback を差し替えるので placeholder は実質見えない。Boundary 無しなら
    // handleError が root で再 throw するのでここには到達しない。
    const owner = new Owner();
    const result = owner.runCatching(() => type(propsProxy));

    // ADR 0066 Phase 2: async function component (= Promise<Node> を返す type) の経路。
    // sync component path は影響を受けない (instanceof Promise が false で素通し)。
    if (result instanceof Promise) {
      // client mode で async function component は ADR 0066 Q2 確定形で throw。
      // user に「.server.tsx に置くか、resource() で client async data を扱う」を
      // 促す message にして debug coster を削減する。
      if (!r.isServer) {
        throw new Error(
          `[vidro] async function component "${type.name || "anonymous"}" is server-only (.server.tsx). Use resource() for client async data.`,
        );
      }
      // server mode: AsyncScope が立っている前提 (renderToStringAsync /
      // streaming SSR の shell-pass で立てる)。`renderToString` (sync) では
      // 立たないので、async component を扱うには renderToStringAsync 必須。
      const scope = getCurrentAsyncScope();
      if (!scope) {
        throw new Error(
          `[vidro] async function component "${type.name || "anonymous"}" requires renderToStringAsync (or Suspense within renderToReadableStream).`,
        );
      }
      // VAsyncSlot を生成して同期に親へ挿げ替える placeholder にする。Promise
      // resolve 時に slot.resolved を書き込み、reject 時は owner.handleError で
      // ErrorBoundary chain (ADR 0063 整合) に流す。serialize 分岐は Phase 3 で追加。
      const slot: VAsyncSlot = { kind: "async-slot", resolved: null };
      const settled = result.then(
        (resolved) => {
          // resolved は ComponentFn の戻り値 = server mode では VNode (Node に cast 済)。
          slot.resolved = resolved as unknown as VNode;
        },
        (err) => {
          // ADR 0066 Q4: shell-pass throw 後の disposed owner への handleError は silent
          // (= render abort 中なので実害なし)。それ以外は ErrorBoundary chain に流す。
          if (!owner.disposed) owner.handleError(err);
        },
      );
      // AsyncScope.pending に push。caller (renderToStringAsync / flushBoundary /
      // flushRoot) が allSettled で待つ (Phase 1 で merge 済)。
      scope.registerPending(settled);
      return slot as unknown as Node;
    }

    return result ?? r.createComment("vidro-error");
  }

  const el = r.createElement(type);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      applyProp(el, key, value);
    }
  }
  for (const child of children) appendChild(el, child);
  return el;
}

/**
 * JSX element を target に mount する。戻り値は dispose 関数で、呼ぶと DOM を除去 + 配下の
 * Effect / child Owner を全て解放する。fn を thunk で受けるのは、root Owner を active にした
 * 状態で JSX を評価するため (h の内側で作られる Effect / 子 Owner がこの root に紐づく)。
 *
 * `mount` は意味論的に **fresh render**: target の既存 children をまず空にしてから新しい
 * tree を append する。SSR (`renderToString`) で焼かれた markup が既にあっても問答無用で
 * 上書き — Phase B-2c の暫定挙動 (一瞬 blink するが状態は壊れない)。Step B-3 の
 * `hydrate(fn, target)` が入ったら、SSR markup を保ったまま walk + effect attach する
 * 別 API として共存する。
 *
 * mount は client only の API なので、target.* は DOM を直接触る (ADR 0016 例外)。
 */
export function mount(fn: () => Node, target: Element): () => void {
  // detached root (parent=null) を作って mount 用の独立スコープにする
  const owner = new Owner(null);
  // runWithMountScope で囲んでいる間、onMount(fn) が queue に積まれる。
  // appendChild の後に flush して、fn は DOM attach 済みの状態で呼ばれる。
  const node = runWithMountScope(() => owner.run(fn));
  // SSR markup や前回 mount 残骸を全消してから fresh attach。replaceChildren は
  // jsdom / 全 modern browser で 1 op で空にできて速い。
  target.replaceChildren();
  target.appendChild(node);
  flushMountQueue();
  return () => {
    node.parentNode?.removeChild(node);
    owner.dispose();
  };
}

// --- internal helpers ---

// 内部 marker key (symbol ではなく property にすることで、transform 生成コードから
// 直接 `fn.__vidroReactive = true` と書けるようにする)。
const REACTIVE_MARKER = "__vidroReactive" as const;

type ReactiveThunk = (() => unknown) & { [REACTIVE_MARKER]?: boolean };

/**
 * A 方式 transform が JSX 内の `{expr}` を `_reactive(() => expr)` に書き換える際に
 * 呼ばれる runtime helper (attribute 位置)。返り値は同じ関数だが marker property
 * が付くので、component 境界の Proxy が「ユーザーが書いた arrow」と区別して展開できる。
 *
 * 使うのは transform だけで、手で書く API ではない (underscore prefix で internal 表現)。
 */
export function _reactive<T>(fn: () => T): () => T {
  (fn as ReactiveThunk)[REACTIVE_MARKER] = true;
  return fn;
}

/**
 * JSX child position の literal text (`<div>hi</div>` の "hi") を transform が書き換えた
 * call 先 (ADR 0019)。h() の引数として **先に** 評価されることで `createText` が
 * `createElement(parent)` より前に呼ばれ、HydrationRenderer の post-order cursor
 * (`<div>hi</div>` の post-order: text, div) と一致する。
 */
export function _$text(value: unknown): Node {
  return getRenderer().createText(toText(value));
}

/**
 * adjacent text/expr boundary に server / client / hydrate 全 mode で同一の
 * empty Comment Node を emit する helper (ADR 0055)。
 *
 * HTML parser は adjacent な text を 1 個の Text Node に merge する仕様があるため、
 * `<button>foo {x}</button>` の SSR 出力 `<button>foo 0</button>` は browser 側で
 * 1 Text Node にまとめられる。client は `_$text("foo ")` + `_$dynamicChild(() => x)`
 * の **2 Text Node** を expect しているので post-order cursor がズレる。
 *
 * `@vidro/plugin` の jsx-transform.ts が intrinsic 親内の adjacent text/expr 隣接を
 * 検知して、間に `_$marker()` を inject する。server は VComment "" → HTML `<!---->`、
 * client は cursor で Comment Node 1 個を消費 → 両者一致。
 *
 * value="" の Comment は anchor 系 ("show", "switch" 等) と完全一致 check で衝突しない
 * (ADR 0055 Open Question 1 参照)。
 */
export function _$marker(): Node {
  return getRenderer().createComment("");
}

/**
 * raw text elements (= `<textarea>` / `<title>` / `<script>` / `<style>`) 内の dynamic child 用 helper。
 * 通常の `_$dynamicChild` は adjacent text/expr 隣接の cursor mismatch を防ぐため `_$marker()` を
 * 周りに挟むが、raw text elements は HTML 仕様で children を plain text 扱いするので、コメントを
 * 書いてもリテラル `<!---->` として visible に残ってしまう (= F7、第 25 周目 dogfood で発見)。
 *
 * 本 helper は marker を入れず Text Node 1 個 + effect で `setText` 更新する形に倒す。raw text
 * elements 内で `<span>` 等の子要素を書く use case は HTML 仕様で禁止なので Node 返り / null 等
 * の edge case は考慮しない (= toText で string flatten すれば足りる)。empty 初期値 (= `""`) でも
 * `_emptyDynamicSlot` の comment ↔ text swap には倒さない (= raw text 内で comment placeholder を
 * 出すと F7 が再発する)、常に Text Node 1 個固定。`_$dynamicChild` との設計非対称は意図的。
 *
 * **制約**: `<textarea>prefix {value}</textarea>` のような JSXText + JSXExpressionContainer の混在は
 * 現状 transform で 2 Text Node に展開され、browser parse 後の Text Node merge と client の
 * 2 Node expect が cursor mismatch する可能性がある。dogfood で出ていないため YAGNI、出たら transform
 * 側で children 全体を 1 thunk に concat する形に改修する。
 *
 * Solid SSR と同様の対策 (= raw text elements で hydration marker を抜く)。
 */
export function _$rawText(thunk: () => unknown): Node {
  const r = getRenderer();
  let peeked = untrack(thunk);
  if (typeof peeked === "function" && (peeked as Function).length === 0) {
    peeked = (peeked as () => unknown)();
  }
  if (peeked instanceof Signal) peeked = peeked.value;
  const text = r.createText(toText(peeked));

  if (r.isServer) return text;

  // effect 内では `getRenderer()` を毎回呼ぶ (= hydrate 完了後の active renderer に切り替わるため)。
  // setText は cursor 消費しないので、_emptyDynamicSlot のような "cursor exhausted" 問題はない。
  effect(() => {
    let v = thunk();
    if (typeof v === "function" && (v as Function).length === 0) v = (v as () => unknown)();
    if (v instanceof Signal) v = v.value;
    getRenderer().setText(text as unknown as Text, toText(v));
  });
  return text;
}

/**
 * JSX child position の `{expr}` (`<div>{count.value}</div>`) を transform が書き換えた
 * call 先 (ADR 0019)。peek + (Array / Node / primitive 判定) を h() より前に行い、
 * 必要なら effect で reactive 追従を仕掛けた上で Node を返す。
 *
 * 旧来 jsx.ts 内の `appendChild` ヘルパーで「function を peek + createText」していた
 * 経路は手書き JSX の後方互換のため残してあるが、transform 経由ではこの helper
 * が先に解決するので post-order が崩れない。
 */
export function _$dynamicChild(thunk: () => unknown): Node {
  const r = getRenderer();
  let peeked = untrack(thunk);

  // 0-arg 関数は children getter として auto-invoke する (ADR 0026、B-4-b)。
  // layout の `<main>{children}</main>` で children が `() => Node` の形で
  // 渡ってきた時に、user 側で `{children()}` と書かなくても展開できるようにする。
  // jsx.ts の handwritten path (appendChild) も同じく function を auto-invoke
  // する設計と一貫性を持たせる。length !== 0 (例: For の (item, i) => ...) は
  // render callback として素通し (本 helper には到達しないが念のため)。
  if (typeof peeked === "function" && (peeked as Function).length === 0) {
    peeked = (peeked as () => unknown)();
  }

  if (Array.isArray(peeked)) {
    const frag = r.createFragment();
    for (const item of peeked) {
      if (item == null || item === false || item === true) continue;
      if (r.isNode(item)) {
        r.appendChild(frag, item);
        continue;
      }
      // 配列内の primitive は static として展開 (動的差し替えは <For> を使う想定)。
      r.appendChild(frag, r.createText(toText(item)));
    }
    return frag;
  }

  if (peeked != null && r.isNode(peeked)) return peeked;

  if (peeked instanceof Signal) {
    const initial = toText(peeked.value);
    if (initial === "") {
      return _emptyDynamicSlot(r, () => peeked.value);
    }
    const text = r.createText(initial);
    effect(() => {
      r.setText(text, toText(peeked.value));
    });
    return text;
  }

  // primitive 値 or unknown → dynamic text。peek した値を初期 text にすることで
  // hydration の cursor 先頭から既存 SSR text content と value 一致しやすい。
  //
  // ADR 0056: 初期値が toText で "" になるケース (LogicalExpression `x && <p/>` の
  // x falsy 時 / null / undefined / boolean / 空文字 など) は、SSR で escapeText("") = ""
  // になり HTML markup に Text Node が現れないので hydrate cursor mismatch する。
  // empty Comment placeholder (`<!---->`) で SSR/hydrate を symmetric にする。
  if (toText(peeked) === "") {
    return _emptyDynamicSlot(r, thunk);
  }
  const text = r.createText(toText(peeked));
  effect(() => {
    let v = thunk();
    // reactive update path も auto-invoke (children が signal で差し替わる
    // ようなケースは無いが、対称性のため)。
    if (typeof v === "function" && (v as Function).length === 0) v = (v as () => unknown)();
    if (v instanceof Signal) v = v.value;
    r.setText(text, toText(v));
  });
  return text;
}

// ADR 0056: 初期値 empty な dynamic slot 用 helper。Comment placeholder を return し、
// client/hydrate では effect 内で comment ↔ text ↔ Node を DOM swap して reactivity を維持する。
// server は ADR 0064 Phase 3 で reactive 化された effect が VNode の kind を
// "comment" ↔ "text" で in-place mutate する (= renderToStringAsync の async tree walk
// で Resource resolve 後に signal 発火 → effect 再評価 → markup が text に差し替わる)。
// renderToString (sync) や streaming SSR の shell-pass では owner が同期 dispose される
// ので 1 回しか走らず、結果として `<!---->` が emit される旧来動作と同じになる。
//
// dogfood 第3周目: `{() => err && <p/>}` のように thunk が Node を返すケースでは、
// client 側で Comment ↔ Element の DOM swap も扱う (= `<Show>` を inline で書ける形に近づける)。
// server 側 Node mutation は VNode shape が異なる (text/comment は `{kind, value}` 同形だが
// element は `{kind, tag, attrs, ...}` で互換性が無い) ため未対応。dogfood の form エラー
// 表示は client 側 reactivity だけで動くので server 側 Node 対応は YAGNI で保留。
//
// effect 内では `getRenderer()` を毎回呼んで「実行時点の active renderer」を取る。
// hydrate 中に install された effect は、hydrate 完了後 (= setRenderer で browserRenderer
// に戻った後) に signal 変化で re-run される。引数の `r` (= HydrationRenderer) を
// closure で掴んでしまうと、後発の `r.createText` が cursor 消費を試みて
// "[hydrate] cursor exhausted" で throw する (review #2 で発見)。
function _emptyDynamicSlot(r: ReturnType<typeof getRenderer>, thunk: () => unknown): Node {
  const placeholder = r.createComment("");

  if (r.isServer) {
    // VComment と VText は同じ shape (`{ kind, value }`) なので、`kind` を切り替える
    // だけで serialize が `<!---->` ↔ text を吐き分ける。VNode 木の中で参照は固定
    // (parent.children 配列の同じ slot に存在し続ける) なので mutation 戦略が成立する。
    type MutableSlot = { kind: "comment" | "text"; value: string };
    const slot = placeholder as unknown as MutableSlot;
    effect(() => {
      let v = thunk();
      if (typeof v === "function" && (v as Function).length === 0) v = (v as () => unknown)();
      if (v instanceof Signal) v = v.value;
      // Node が返るケース: server 側 mutation は未対応。slot は comment のまま固定にして
      // 静的 fallback とする (= dogfood の form エラー表示は server 側で reactive 化されない)。
      if (v != null && r.isNode(v)) return;
      const next = toText(v);
      if (next === "") {
        slot.kind = "comment";
        slot.value = "";
      } else {
        slot.kind = "text";
        slot.value = next;
      }
    });
    return placeholder;
  }

  let current: Node = placeholder;
  effect(() => {
    let v = thunk();
    if (typeof v === "function" && (v as Function).length === 0) v = (v as () => unknown)();
    if (v instanceof Signal) v = v.value;
    const active = getRenderer();

    // 初回 effect 同期実行時 (= effect() 呼び出し直後) は placeholder がまだ親に
    // append されていないので `current.parentNode === null`。DOM 操作 skip + `current`
    // ポインタも維持して、return された placeholder と `current` の不一致を防ぐ。
    // 後続の effect 再実行 (= signal 変化後) は hydrate / mount 完了後で
    // parentNode が必ず非 null。

    // Node 返りは current を Node に置き換える。`<Show>` の anchor + branch swap と
    // 同じ戦略で、parent.replaceChild で in-place DOM swap する。
    if (v != null && active.isNode(v)) {
      if (current === v) return;
      const parent = current.parentNode;
      if (!parent) return;
      parent.replaceChild(v, current);
      current = v;
      return;
    }

    const next = toText(v);
    const nodeType = current.nodeType;
    const isComment = nodeType === 8 /* Node.COMMENT_NODE */;
    const isText = nodeType === 3 /* Node.TEXT_NODE */;

    if (next === "") {
      if (isComment) return;
      const parent = current.parentNode;
      if (!parent) return;
      const replacement = active.createComment("");
      parent.replaceChild(replacement, current);
      current = replacement;
      return;
    }

    if (isText) {
      active.setText(current as Text, next);
      return;
    }
    // current が Comment または Element の場合は Text に置き換える
    const parent = current.parentNode;
    if (!parent) return;
    const replacement = active.createText(next);
    parent.replaceChild(replacement, current);
    current = replacement;
  });
  return current;
}

// Component に渡す props を Proxy でラップする。getter アクセス時に transform 由来
// の marker 付き関数だけを展開し、ユーザーが書いた arrow (event handler / render
// callback / fallback factory 等) は関数のまま素通す。
function wrapComponentProps(rawProps: Record<string, unknown>): Record<string, unknown> {
  return new Proxy(rawProps, {
    get(target, key) {
      const raw = (target as Record<string | symbol, unknown>)[key];
      if (key === "children") return raw;
      if (typeof key === "string" && key.startsWith("on") && key.length > 2) return raw;
      if (typeof raw === "function" && (raw as ReactiveThunk)[REACTIVE_MARKER]) {
        return (raw as () => unknown)();
      }
      return raw;
    },
  });
}

// 親 Node に 1 つの child slot 値を追加する。Signal / 関数は Effect で reactive 追従する。
function appendChild(parent: Node, child: unknown): void {
  if (child == null || child === false || child === true) return;

  const r = getRenderer();

  if (Array.isArray(child)) {
    for (const c of child) appendChild(parent, c);
    return;
  }

  if (r.isNode(child)) {
    r.appendChild(parent, child);
    return;
  }

  if (child instanceof Signal) {
    // B 書き: `{signal}` をそのまま渡された場合のサポート
    const text = r.createText("");
    r.appendChild(parent, text);
    effect(() => {
      r.setText(text, toText(child.value));
    });
    return;
  }

  if (typeof child === "function") {
    // A 方式 compile transform の結果 (`{expr}` → `() => expr`) を受ける。
    // 依存追跡なしで peek して、返り値が静的な構造 (Array / Node) の場合は static
    // スロットとして展開する。配列を動的に差し替えたいケースは <For> を使う想定で、
    // appendChild では初回評価のみの挿入にとどめる。
    // primitive / Signal は dynamic text として effect 内で追従。
    const peeked = untrack(() => (child as () => unknown)());
    if (Array.isArray(peeked)) {
      for (const c of peeked) appendChild(parent, c);
      return;
    }
    if (r.isNode(peeked)) {
      r.appendChild(parent, peeked);
      return;
    }
    const text = r.createText("");
    r.appendChild(parent, text);
    // 初回は上の peek で評価済みだが、依存追跡に乗せるため effect 内で改めて呼ぶ。
    // `{signal}` が transform されたケースでは返り値が Signal instance になるので、
    // もう一段 .value を読んで unwrap する (forward-compat)。
    effect(() => {
      let v = (child as () => unknown)();
      if (v instanceof Signal) v = v.value;
      r.setText(text, toText(v));
    });
    return;
  }

  // primitive (string / number / bigint 等)
  r.appendChild(parent, r.createText(toText(child)));
}

// null / undefined / false は空文字、primitive は文字列化、object 等は空文字で妥協する
function toText(value: unknown): string {
  if (value == null || value === false) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

// input.value / checkbox.checked / option.selected 等は attribute ではなく DOM property で
// 扱う必要がある (ユーザー操作で変動する live state と attribute が別 bookkeeping のため)。
const PROPS_AS_PROPERTY = new Set(["value", "checked", "selected"]);

// Element に 1 つの prop を適用する。on[Event] は listener、function / Signal は reactive。
function applyProp(el: Element, key: string, value: unknown): void {
  const r = getRenderer();

  // ref={myRef} は属性としてではなく、Ref インスタンスの .current に要素を代入して終了。
  // Ref 以外 (関数 callback 等) は現状サポート対象外、黙って attribute 化せず捨てる。
  if (key === "ref") {
    if (value instanceof Ref) (value as Ref<Element>).current = el;
    return;
  }

  if (key.startsWith("on") && key.length > 2 && typeof value === "function") {
    const eventName = key.slice(2).toLowerCase();
    r.addEventListener(el, eventName, value as EventListener);
    return;
  }

  const apply = PROPS_AS_PROPERTY.has(key) ? setProperty : setAttr;

  if (value instanceof Signal) {
    effect(() => {
      apply(el, key, value.value);
    });
    return;
  }

  if (typeof value === "function") {
    effect(() => {
      let v = (value as () => unknown)();
      if (v instanceof Signal) v = v.value;
      apply(el, key, v);
    });
    return;
  }

  apply(el, key, value);
}

// DOM property に直接代入 (null / undefined は空文字へ正規化)
function setProperty(el: Element, key: string, value: unknown): void {
  getRenderer().setProperty(el, key, value);
}

// class / className / style を特別扱いし、それ以外は setAttribute / removeAttribute を使う
function setAttr(el: Element, key: string, value: unknown): void {
  const r = getRenderer();

  if (key === "class" || key === "className") {
    r.setClassName(el, toAttrString(value));
    return;
  }

  if (key === "style" && value !== null && typeof value === "object") {
    r.assignStyle(el, value as Record<string, unknown>);
    return;
  }

  if (value == null || value === false) {
    r.removeAttribute(el, key);
    return;
  }

  if (value === true) {
    r.setAttribute(el, key, "");
    return;
  }

  r.setAttribute(el, key, toAttrString(value));
}

// 属性値として受け入れる primitive のみ文字列化する。オブジェクト等は空文字にして
// "[object Object]" のゴミ値を setAttribute に渡さないようにする。
function toAttrString(value: unknown): string {
  if (value == null || value === false) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

// JSX の型宣言 (permissive)。Stage 1 では全 intrinsic 要素を Record<string, unknown> で受ける。
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    type Element = Node;
    interface IntrinsicElements {
      [elemName: string]: Record<string, unknown>;
    }
    interface ElementChildrenAttribute {
      children: unknown;
    }
  }
}
