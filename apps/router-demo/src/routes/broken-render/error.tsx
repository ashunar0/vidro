import type { ErrorPageProps } from "@vidro/router";

// 内側 error.tsx (broken-render)。layout render error は「broken-render layout の
// 内側」なので、この error.tsx は使われない想定 (ADR 0010)。root error.tsx が勝つ。
export default function BrokenRenderInnerError({ error }: ErrorPageProps) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <section
      data-testid="broken-render-inner-error"
      style="border: 2px solid #060; padding: 1rem; border-radius: 4px; background: #efe;"
    >
      <h2 style="color: #060; margin-top: 0;">broken-render inner error (SHOULD NOT appear)</h2>
      <p>
        Message: <code>{message}</code>
      </p>
    </section>
  );
}
