import type { ActionArgs } from "@vidro/router";

// signup form dogfood — `feedback_dx_first_design` per、ADR 0058 (.server.tsx
// semantics) + ADR 0059 (validation error primitive) Accepted 後の form sketch。
//
// ADR 0059 規約: validation 失敗時は `throw new Response(JSON, {status: 422})`、
// body に `{fields: Record<string,string>}` を入れる。client 側は sub.fieldError
// で取得 (= ad-hoc narrowing 不要)。

type User = { id: number; email: string; passwordHash: string };

const users: User[] = [];
let nextId = 1;

// toy hash (本来は bcrypt 等)。dogfood の主旨は form mechanic なので簡略。
function hashPassword(pw: string): string {
  return `hashed:${pw}`;
}

function getStringField(fd: FormData, name: string): string {
  const v = fd.get(name);
  return typeof v === "string" ? v : "";
}

export async function action({ request }: ActionArgs<"/signup">) {
  const fd = await request.formData();
  const email = getStringField(fd, "email").trim();
  const password = getStringField(fd, "password");
  const passwordConfirm = getStringField(fd, "passwordConfirm");

  const fieldErrors: Record<string, string> = {};
  if (!email.includes("@")) fieldErrors.email = "メールアドレスの形式が正しくありません";
  if (password.length < 8) fieldErrors.password = "8 文字以上で入力してください";
  if (password !== passwordConfirm) fieldErrors.passwordConfirm = "パスワードが一致しません";

  if (Object.keys(fieldErrors).length === 0) {
    const existing = users.find((u) => u.email === email);
    if (existing) fieldErrors.email = "このメールアドレスは既に登録されています";
  }

  // ADR 0059: validation error は 422 Response throw。client の sub.fieldError に流れる。
  if (Object.keys(fieldErrors).length > 0) {
    throw new Response(JSON.stringify({ fields: fieldErrors }), {
      status: 422,
      headers: { "Content-Type": "application/json" },
    });
  }

  const user: User = {
    id: nextId++,
    email,
    passwordHash: hashPassword(password),
  };
  users.push(user);

  // 成功 → home に redirect (signup 完了表示は別 route に分けない toy demo 都合)
  return Response.redirect(new URL("/", request.url).toString(), 303);
}
