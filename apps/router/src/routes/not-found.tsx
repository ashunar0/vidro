import { Link } from "@vidro/router";

export default function NotFound() {
  return (
    <div>
      <h2 class="text-xl font-semibold">404 Not Found</h2>
      <p class="mt-4 text-gray-700">URL に match する route が無いのだ。</p>
      <Link href="/" class="mt-4 inline-block text-blue-500 underline">
        ← Home に戻る
      </Link>
    </div>
  );
}
