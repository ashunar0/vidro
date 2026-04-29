// loader は route が match した時に server で実行される関数。
// 戻り値の型がそのまま PageProps<typeof loader> で component に届く (= 型貫通)。
import { posts } from "../data/posts";

export async function loader() {
  return { posts };
}
