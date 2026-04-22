type Variant = "default" | "muted" | "icon" | "icon-sm";

type ButtonProps = {
  onClick?: (e: MouseEvent) => void;
  "aria-label"?: string;
  variant?: Variant;
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

export function Button(props: ButtonProps) {
  const variant = props.variant ?? "default";
  return (
    <button
      type="button"
      class={`${BASE} ${VARIANTS[variant]}`}
      aria-label={props["aria-label"]}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}
