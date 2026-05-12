// /about/* 配下に scoped な layout (filesystem-based 規約)。AboutLayout を re-export。
// _renderer.tsx 規約: そのディレクトリ + 配下全 route に適用される (= 親 _renderer.tsx の内側に nested)。

export { AboutLayout as default } from "../../domains/about/layouts/AboutLayout.tsx";
