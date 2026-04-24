// loader 関数の引数型。最小版では params のみ。将来 request / context が増える
// 想定で型をこの場所に集約しておく。
export type LoaderArgs<Params extends Record<string, string> = Record<string, string>> = {
  params: Params;
};

// loader として受け入れる関数の最低条件。`PageProps<L>` の generic 制約に使う。
type AnyLoader = (args: LoaderArgs<any>) => Promise<unknown>;

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

// layout component が受け取る props 型。Phase 3 第 1 弾では layout 自身の loader は
// scope 外なので、PageProps とは独立した shape にしている (Params + children)。
// layout loader が来たら、ここも loader generic を取れるよう拡張する。
export type LayoutProps<Params extends Record<string, string> = Record<string, string>> = {
  params: Params;
  children: Node;
};
