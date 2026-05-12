// /posts/* 配下に scoped な layout。PostsLayout を re-export。
// _renderer.tsx 規約: そのディレクトリ + 配下全 route に適用される (= 親 _renderer.tsx の内側に nested)。

export { PostsLayout as default } from "../../../src/domains/posts/layouts/PostsLayout.tsx";
