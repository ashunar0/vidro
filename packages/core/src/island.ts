// ADR 0060 partial hydration: `__VidroIsland` SSR 専用 helper component。
//
// 役割: `.server.tsx` 内の island JSX (= `.tsx` import 由来の component) を、
// jsx-transform が server build pass で
//   `<__VidroIsland name="Counter" props={{initial: 0}}><Counter initial={0}/></__VidroIsland>`
// にラップした時の wrapper 実装。SSR で:
//   1. per-render の name counter を引いて seq 決定 (= 同 component 複数 instance を区別)
//   2. `<!--vi-${name}-${seq}-start:{props_json}-->` start marker emit
//   3. children() (= 元 island JSX) を server で render → Node を fragment に append
//   4. `<!--vi-${name}-${seq}-end-->` end marker emit
//   5. `<script>(window.__vidroIslandHydrate??=[]).push({key, name, seq})</script>` で
//      registry push (boundary registry `__vidroPendingHydrate` と完全に namespace 分離)
//
// client では一切呼ばれない: `.server.tsx` は client bundle で server-component plugin
// により stub virtual module に置換されるため (ADR 0060 Phase 1)。defensive に「server
// 以外の renderer」を検出したら children を素通しで return する fallback を持つ。
//
// props serialize: ADR 0060 H-α で JSON 限定 + serialize 失敗時 throw を decide 済。
// `JSON.stringify` がそのまま信頼できる (Date / Map / class instance を渡したら throw)。

import { getRenderer } from "./renderer";
import { getIslandSeqState } from "./island-scope";

export type VidroIslandProps = {
  name: string;
  props: Record<string, unknown>;
  // jsx-transform で component child は thunk 化される (ADR 0025) ので、children は
  // `() => Node` の getter 形式で渡る。h() の rest 引数 1 個 = props.children に unwrap される。
  // 防御的に Node 直渡し / 配列 もありうるので unknown で受ける。
  children?: unknown;
};

export function __VidroIsland(props: VidroIslandProps): unknown {
  const renderer = getRenderer();

  // Defensive: client では呼ばれない想定だが、isServer false なら children を素通し
  if (!renderer.isServer) {
    return invokeChildren(props.children);
  }

  // per-render seq counter (scope 不在時は 1 fallback)
  const state = getIslandSeqState();
  let seq = 1;
  if (state) {
    seq = (state.get(props.name) ?? 0) + 1;
    state.set(props.name, seq);
  }

  const key = `vi-${props.name}-${seq}`;
  // ADR 0060 H-α: JSON 限定。Date / Map / class instance は throw (= user に
  // serialize 制約を build error 級で気付かせる)。
  const propsJson = serializeIslandProps(props.props ?? {}, props.name);

  const fragment = renderer.createFragment();

  // start marker (props inline JSON で D-α)
  renderer.appendChild(fragment, renderer.createComment(`${key}-start:${propsJson}`));

  // children (= 元 island JSX) を server で render。thunk なら invoke、Node なら直接 append。
  const childNode = invokeChildren(props.children);
  if (childNode != null && renderer.isNode(childNode)) {
    renderer.appendChild(fragment, childNode);
  }

  // end marker
  renderer.appendChild(fragment, renderer.createComment(`${key}-end`));

  // registry push script (per-island に 1 個 emit)
  // E-α: __vidroIslandHydrate (= 53rd で namespace 分離した array) に entry を push。
  // boundary registry __vidroPendingHydrate (= map shape, vb-* key) と完全独立。
  const script = renderer.createElement("script");
  const text = renderer.createText(
    `(window.__vidroIslandHydrate=window.__vidroIslandHydrate||[]).push(${escapeJsonForScript({
      key,
      name: props.name,
      seq,
    })});`,
  );
  renderer.appendChild(script, text);
  renderer.appendChild(fragment, script);

  return fragment;
}

// thunk なら invoke、Node 直渡しなら素通し、配列等は最初の要素を取る (= h() の
// rest 引数 1 個ケースを基本前提)。配列対応は `<__VidroIsland>` に複数 children を
// 書く想定が薄いので最低限 (将来 `_$dynamicChild` 級の処理が要れば追加)。
function invokeChildren(children: VidroIslandProps["children"]): unknown {
  if (typeof children === "function") {
    return (children as () => unknown)();
  }
  return children;
}

function serializeIslandProps(value: Record<string, unknown>, islandName: string): string {
  try {
    return escapeCommentJSON(JSON.stringify(value));
  } catch (err) {
    throw new Error(
      `[vidro] island '${islandName}' has non-serializable props.\n` +
        `  Reason: ${err instanceof Error ? err.message : String(err)}\n` +
        `  Pass JSON-compatible primitives only (string / number / boolean / array / plain object).\n` +
        `  Date / Map / Set / class instance / function は ADR 0060 H-α で受け付けない設計です。`,
    );
  }
}

// HTML comment 内に embed する用の JSON escape。`-->` で comment が早期 close するのと、
// `--` 連続を含む comment 内容は HTML5 spec で invalid なので回避する。
//
// client 側 `extractPropsJSON` は `comment.nodeValue` をリテラルテキストとして取得し
// `JSON.parse` で復元する。`-` は **JSON unicode escape** として `JSON.parse` が
// 自動で `-` に戻す (= browser が HTML unescape する経路ではなく、JSON 仕様の責務)。
// よってラウンドトリップが成立する (= reviewer W-3 文書化補足)。
function escapeCommentJSON(json: string): string {
  // `--` 連続 を `--` に escape (= JSON 文字列内では 1 文字 `-` として復元される)
  return json.replace(/--/g, "-\\u002d");
}

// ADR 0060 partial hydration — `.server.tsx` page output 全体を「shell hydrate cursor が
// skip する static span」で囲む helper component。
//
// 設計の根拠:
//   `.server.tsx` page を Router が render する際、server build では実体評価で HTML を
//   出すが、client bundle では server-component plugin が stub `() => null` に置換する。
//   shell hydrate (= boot 経路) は stub の null output と SSR HTML の `<div>...</div>` が
//   不一致になり cursor mismatch を起こす。
//
//   解決: ADR 0035 streaming hydrate の `skipToComment` API を流用、page output 全体を
//   `<!--vs-1-start-->...<!--vs-1-end-->` で囲む。shell cursor は span 全体を skip し、
//   内部の島 marker (`<!--vi-X-N-->`) は別経路 (= setupIslandHydration) で hydrate する。
//
// Routerが `.server.tsx` route を検出した時、leaf component 呼び出しを本 wrapper で
// 囲む形で組み込む (router/router.tsx foldRouteTree 内)。
//
// scope:
//   - id 固定 = `vs-1`。1 page = 1 span 前提。layout 含む nested .server.tsx 対応は
//     scope 外 (= 必要になったら per-render counter 化、既存 streaming context 同様)
//   - shell hydrate (= renderer.streaming === true) のみ skip 経路。boundary 単位 hydrate
//     (= ADR 0035 hydrateRange) では range が島 marker の範囲なので vs-* には触れない

// HydrationRenderer が公開する内部 API。ADR 0035 で定義されている skipToComment を
// 型として宣言し、core 内の他 module からも一貫して使えるようにする。
type RendererWithSkip = {
  streaming?: boolean;
  skipToComment?: (value: string) => void;
};

export function __VidroServerOnlySection(props: { children?: unknown }): unknown {
  const renderer = getRenderer();

  // server: page output を marker comment で囲む。子 (= 元 .server.tsx の default 出力)
  // は invokeChildren で評価し、その前後に start / end marker を吐く fragment にまとめる。
  if (renderer.isServer) {
    const fragment = renderer.createFragment();
    renderer.appendChild(fragment, renderer.createComment("vs-1-start"));
    const child = invokeChildren(props.children);
    if (child != null && renderer.isNode(child)) {
      renderer.appendChild(fragment, child);
    }
    renderer.appendChild(fragment, renderer.createComment("vs-1-end"));
    return fragment;
  }

  // client side。HydrationRenderer なら skipToComment が定義されてる (= ADR 0035 で
  // 追加した API)。`streaming` flag は SSR が Suspense を使った時だけ true なので
  // 判定に使えない (= `.server.tsx` page は Suspense 不使用でも skip が必要)。
  // skipToComment の存在 = HydrationRenderer 全般で true。実質「shell hydrate or
  // hydrateRange の cursor active」を判定。`.server.tsx` を nested に使う将来拡張
  // (= island 内に `.server.tsx` を含める等) では hydrateRange 経由でこのコンポーネント
  // が呼ばれるケースもあり得るが、その時は range 内に vs-1-end が無くて throw する
  // 想定 — 現 ADR scope では nested 不採用なので問題にならない (= reviewer m-1)。
  //
  // skipToComment は cursor を end marker そのものを指す位置まで進めるので、その後 1 個
  // createComment を呼んで end marker を消費する形にする (= cursor を end の次に進める)。
  // children (= stub の default = `() => null`) は呼ばない (= server-only logic を client
  // で実行しない pure skip)。
  const hr = renderer as RendererWithSkip;
  if (typeof hr.skipToComment === "function") {
    hr.skipToComment("vs-1-end");
    return renderer.createComment("vs-1-end");
  }

  // CSR fresh mount (= SSR markup なし、または non-streaming hydrate) — 該当ケースは
  // .server.tsx page で発生する想定が薄いが、defensive に children を素通しで return。
  // server-component stub の default は null を返すので、結果は null (= 何も render しない)。
  const child = invokeChildren(props.children);
  if (child != null && renderer.isNode(child)) return child;
  return renderer.createComment("vs-1-empty");
}

// `<script>...</script>` 内に inline する JSON の escape (XSS 対策、`</script>` 閉じ防止)
function escapeJsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}
