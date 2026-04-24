// route component が受け取る props 型。dynamic segment `[id]` 等から抽出された
// params を Record<string, string> として渡す。Params 未指定時は緩い形で
// fallback するので、params を使わない route は `function Home()` のように
// 引数を省略できる (TypeScript の関数 contravariance による)。
//
// Phase 3 で loader / searchParams が来たら、ここに generic 引数を追加する。
export type PageProps<Params extends Record<string, string> = Record<string, string>> = {
  params: Params;
};
