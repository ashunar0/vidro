import { Show } from "@vidro/core";

// Presentational kind の dogfood — `project_responsibility_separation_focus`
// per の pure rendering component。state を持たず props in / JSX out。
//
// 切り出し判断 (= ADR 0057 stance、`project_fw_design_stance`):
//   - 同じ markup 構造 (label + input + error message) が 3 回繰り返してる
//   - 「Field」というドメイン名がつく
//   - 別 form (login / contact 等) でも再利用見込み
//   → 3/3 揃ったので切り出し OK (= 公式推奨レベル、強制ゼロ)。
//
// 実装上の注意 (= 51st dogfood で踏んだ既知制約):
//
//   1. **props は destructure しない**: ADR 0007 (props proxy reactive) が
//      Soft supersede 中 (`project_pending_rewrites` per)。destructure すると
//      proxy の reactive 化が壊れて props が snapshot 値で固定される。
//      props.xxx で都度 access する。ADR 0048 (props snapshot) の Hard supersede
//      後はこの注意は消える。
//
//   2. **conditional render は `<Show>` を使う**: `{cond && <p/>}` パターンは
//      初回 peek で false を見ると effect が仕掛けられず、後で truthy に
//      toggle しても DOM 更新されない (`project_pending_rewrites` per の
//      ADR 0019 + toText 既存制約)。`<Show when={() => props.error}>` で
//      reactive boundary を作る。

type FieldProps = {
  name: string;
  label: string;
  type?: string;
  error?: string;
};

export function Field(props: FieldProps) {
  return (
    <div>
      <label for={props.name} class="block text-sm font-medium">
        {props.label}
      </label>
      <input
        id={props.name}
        name={props.name}
        type={props.type ?? "text"}
        class="mt-1 w-full rounded border px-3 py-2"
      />
      <Show when={() => props.error}>
        {() => <p class="mt-1 text-sm text-red-600">{props.error}</p>}
      </Show>
    </div>
  );
}
