import type { ErrorPageProps } from "@vidro/router";

// root error.tsx。loader error / render error の両方をここで受け取る。
// nested に routes/users/error.tsx を置けばそちら優先。
export default function RootError({ error, reset, params }: ErrorPageProps) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <section
      data-testid="error-page"
      style="border: 2px solid #c00; padding: 1rem; border-radius: 4px; background: #fee;"
    >
      <h2 style="color: #c00; margin-top: 0;">Something went wrong</h2>
      <p>
        Message: <code>{message}</code>
      </p>
      {Object.keys(params).length > 0 && (
        <p>
          Params: <code>{JSON.stringify(params)}</code>
        </p>
      )}
      <button onClick={reset} style="margin-top: 0.5rem;">
        Retry
      </button>
    </section>
  );
}
