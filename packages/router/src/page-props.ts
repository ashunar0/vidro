// route component が受け取る props 型。dynamic segment `[id]` 等から抽出された
// params を Record<string, string> として渡す。Params 未指定時は緩い形で
// fallback するので、params を使わない route は `function Home()` のように
// 引数を省略できる (TypeScript の関数 contravariance による)。
//
// Phase 3 で loader / searchParams が来たら、ここに generic 引数を追加する。
export type PageProps<Params extends Record<string, string> = Record<string, string>> = {
  params: Params;
};

// layout component が受け取る props 型。PageProps に children を加えただけ。
// 親 layout からは深い segment の params を型として知り得ないので、デフォルトは
// 緩い Record<string, string>。明示的に絞りたければ `LayoutProps<{ id: string }>`。
export type LayoutProps<Params extends Record<string, string> = Record<string, string>> =
  PageProps<Params> & {
    children: Node;
  };
