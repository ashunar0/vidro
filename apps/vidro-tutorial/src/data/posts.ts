// 一覧 / 詳細の両方の loader が import する共有データ。
// 本来は application 層 (= DB / repository 経由) に置くものだが、toy 段階では
// in-memory 配列で十分。後の Step で「このファイルを repository 化する」流れに繋がる。
export type Post = {
  id: number;
  title: string;
  body: string;
};

export const posts: Post[] = [
  { id: 1, title: "はじめての投稿", body: "投稿の本文なのだ。" },
  { id: 2, title: "2 つ目の投稿", body: "2 つ目の本文。" },
];
