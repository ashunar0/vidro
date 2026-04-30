import type { ErrorPageProps } from "@vidro/router";

// root error.tsx。loader error / render error をここで catch する。
// nested に置きたければ routes/<sub>/error.tsx を作れば子 tree を優先 cover。
export default function RootError({ error, reset, params }: ErrorPageProps) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div class="rounded border-2 border-red-400 bg-red-50 p-4">
      <h2 class="text-xl font-semibold text-red-700">Something went wrong</h2>
      <p class="mt-2">
        Message: <code class="rounded bg-white px-1 py-0.5">{message}</code>
      </p>
      {Object.keys(params).length > 0 && (
        <p class="mt-2">
          Params: <code class="rounded bg-white px-1 py-0.5">{JSON.stringify(params)}</code>
        </p>
      )}
      <button
        type="button"
        onClick={reset}
        class="mt-3 rounded bg-red-500 px-3 py-1 text-white hover:bg-red-600"
      >
        Retry
      </button>
    </div>
  );
}
