import type { ErrorPageProps } from "@vidro/router";

// 内側 error.tsx。broken-loader layout の loader が throw するとき、この error.tsx
// は「broken-loader layout の内側」なので使われず、root error.tsx が使われるのが
// 正しい挙動 (ADR 0010)。data-testid でどちらが描画されたかを test で判別できる。
export default function BrokenLoaderInnerError({ error }: ErrorPageProps) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <section
      data-testid="broken-loader-inner-error"
      style="border: 2px solid #060; padding: 1rem; border-radius: 4px; background: #efe;"
    >
      <h2 style="color: #060; margin-top: 0;">broken-loader inner error (SHOULD NOT appear)</h2>
      <p>
        Message: <code>{message}</code>
      </p>
    </section>
  );
}
