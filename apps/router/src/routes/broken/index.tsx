// 意図的に render 中に throw する page。root error.tsx の挙動を確認する用。
export default function Broken(): never {
  throw new Error("意図的な render error なのだ (broken/index.tsx)");
}
