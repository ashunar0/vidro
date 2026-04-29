import { resource, Suspense, Show, For } from "@vidro/core";

type User = {
  id: number;
  name: string;
  email: string;
};

// Step 2: Suspense で loading 分岐を JSX から消す。
// resource は Suspense の子 component (UserList) の中で構築する必要がある
// (resource constructor が getCurrentSuspense() で nearest scope を捕捉する仕組み)。
export function Users() {
  return (
    <div class="mx-auto max-w-md p-8 font-sans">
      <h1 class="mb-6 text-2xl font-bold">Users</h1>
      <Suspense fallback={() => <p class="text-sm text-slate-500">読み込み中...</p>}>
        {() => <UserList />}
      </Suspense>
    </div>
  );
}

// resource を Suspense の中で読むので、loading 分岐は Suspense が自動処理。
// error 分岐は Suspense では handle しない (ErrorBoundary が別概念) ので Show 維持。
function UserList() {
  const users = resource<User[]>(async () => {
    await new Promise((r) => setTimeout(r, 500));
    const res = await fetch("https://jsonplaceholder.typicode.com/users");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as User[];
  });

  return (
    <div>
      <Show when={users.error}>
        <p class="text-sm text-red-500">エラー: {String(users.error)}</p>
      </Show>
      <ul class="space-y-2">
        <For each={users.value ?? []}>
          {(user) => (
            <li class="rounded border px-3 py-2">
              <div class="font-semibold">{user.name}</div>
              <div class="text-sm text-slate-500">{user.email}</div>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}
