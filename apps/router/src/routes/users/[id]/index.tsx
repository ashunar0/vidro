// loader を持たない dynamic param page。`PageProps` は loader 必須前提
// (L extends AnyLoader) なので、loader 無し case では型を直書きしている。
// dogfood で見つけた論点 — 将来 `PageProps` が loader 省略を許容する余地あり。
export default function User({ params }: { params: { id: string } }) {
  return (
    <div>
      <h2 class="text-xl font-semibold">User #{params.id}</h2>
      <p class="mt-4 text-gray-700">
        URL の <code class="rounded bg-gray-100 px-1 py-0.5">[id]</code> 部分が
        <strong class="ml-1">{params.id}</strong> として届いた。
      </p>
    </div>
  );
}
