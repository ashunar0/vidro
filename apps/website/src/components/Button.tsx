type Variant = "default" | "muted" | "icon" | "icon-sm";

type ButtonProps = {
  onClick?: (e: MouseEvent) => void;
  "aria-label"?: string;
  variant?: Variant;
  // 関数で渡すと h 側が Effect で追従する (active 状態を reactive に変えたい時用)
  active?: () => boolean;
  children?: unknown;
};

// ボタンの base スタイル (枠・hover・transition) を共通化し、variant でサイズと色味を切替。
const BASE =
  "border border-neutral-300 dark:border-neutral-700 rounded-lg hover:border-indigo-500 dark:hover:border-indigo-400 hover:text-indigo-500 dark:hover:text-indigo-400 transition-colors cursor-pointer bg-transparent";

const VARIANTS: Record<Variant, string> = {
  default: "px-5 py-2",
  muted: "px-5 py-2 text-sm text-neutral-500 dark:text-neutral-400",
  icon: "w-12 h-12 text-2xl inline-flex items-center justify-center",
  "icon-sm": "px-2.5 py-1 text-sm",
};

const ACTIVE = "border-indigo-500 dark:border-indigo-400 text-indigo-500 dark:text-indigo-400";

export function Button(props: ButtonProps) {
  const variant = props.variant ?? "default";
  const baseClass = `${BASE} ${VARIANTS[variant]}`;
  // active が渡されていれば class を関数化 → h が Effect で class 属性を追従更新
  const classExpr = props.active
    ? () => `${baseClass} ${props.active?.() ? ACTIVE : ""}`
    : baseClass;
  return (
    <button
      type="button"
      class={classExpr}
      aria-label={props["aria-label"]}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}
