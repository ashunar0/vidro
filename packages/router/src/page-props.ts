// Route 型辞書。`@vidro/plugin` の `routeTypes()` が `declare module "@vidro/router"`
// でこの interface を augment し、`"/users/:id": { params: { id: string } }` 等の
// エントリを流し込む。初期状態は空で、plugin を使わない場合は `LoaderArgs` の
// generic が効かなくなるだけで runtime には影響しない。
//
// interface にしている理由: `declare module` 側から augment 可能にするため
// (`type` だと交差できず上書きも不可)。
export interface RouteMap {}

// plugin が augment した RouteMap の alias。`keyof Routes` で route path literal
// union が取れる。user 側で `Routes["/users/:id"]["params"]` のように書きたい
// 場合にもこちらを使う。
export type Routes = RouteMap;

// loader 関数の引数型。`R` に route path (`"/users/:id"` 等) を渡すと、
// `params` の型が RouteMap 辞書から自動展開される。generic を省略すると全 route
// の params の union になる (= 触るときに narrow が要る)。params を触らない
// loader (layout でよくある) は省略 OK、触るなら必ず route path を明示する運用。
//
// 将来 `request` / worker context 等が増えたときもここ 1 箇所に足せば、helper
// を使ってる全 loader が追従する (ADR 0011)。
export type LoaderArgs<R extends keyof Routes = keyof Routes> = {
  params: Routes[R]["params"];
};

// loader として受け入れる関数の最低条件。`PageProps<L>` / `LayoutProps<L>` の
// generic 制約に使う。params shape は route ごとに異なるので `any` で受けて、
// 本当の型は `Parameters<L>[0]["params"]` で個別に取り出す。
type AnyLoader = (args: { params: any }) => Promise<unknown>;

// route component が受け取る props 型。loader 関数そのものを generic に取り、
// `data` (loader の戻り値) と `params` (loader の引数から抽出) を一気に型付けする。
// この設計により、loader の戻り値型を変えるだけで component 側の data 型が
// 自動追従する (= DB → UI まで型が 1 本で貫通する)。
//
// 使い方: `function User({ data, params }: PageProps<typeof loader>)`
//
// loader を持たない route (Home / About 等) は引数を省略する (関数 contravariance で互換)。
export type PageProps<L extends AnyLoader> = {
  data: Awaited<ReturnType<L>>;
  params: Parameters<L>[0]["params"];
};

// layout component が受け取る props 型。
// - loader **なし** layout: `LayoutProps` (generic 省略) → `{ params, children }` の shape。
// - loader **あり** layout: `LayoutProps<typeof loader>` → `{ data, params, children }` に
//   膨らむ。PageProps と同じ思想で、loader の戻り値型を変えるだけで data 型が追従する。
//
// conditional type で 1 つの型に両対応を畳んでいるのは、layout を書くときに
// loader 有無で「別の型名を使い分ける」ことを避けたいため。PageProps は loader 必須
// 前提なのに対し、layout は loader optional という違いがここに出ている。
export type LayoutProps<L extends AnyLoader | undefined = undefined> = L extends AnyLoader
  ? {
      data: Awaited<ReturnType<L>>;
      params: Parameters<L>[0]["params"];
      children: Node;
    }
  : {
      params: Record<string, string>;
      children: Node;
    };

// error.tsx が受け取る props 型。loader / render で発生した error を `error` で受けて、
// `reset()` で同 pathname に再 navigate (loader 再実行) を促す。`params` は最寄りの
// route が抽出した値 (route 自体が match しない 404 ケースでは空 object)。
export type ErrorPageProps = {
  error: unknown;
  reset: () => void;
  params: Record<string, string>;
};
