import { Link } from "@vidro/router";

export default function NewPost() {
  return (
    <>
      <Link href="/">← 一覧へ戻る</Link>
      <h1>新規投稿</h1>
      <form method="post">
        <div>
          <label htmlFor="title">タイトル</label>
          <input type="text" id="title" name="title" />
        </div>
        <div>
          <label htmlFor="body">本文</label>
          <textarea id="body" name="body"></textarea>
        </div>
        <button type="submit">投稿する</button>
      </form>
    </>
  );
}
