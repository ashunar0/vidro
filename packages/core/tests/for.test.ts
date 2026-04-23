// @vitest-environment jsdom
import { describe, expect, test } from "vite-plus/test";
import { signal } from "../src/signal";
import { effect } from "../src/effect";
import { For } from "../src/for";
import { mount } from "../src/jsx";

type Item = { id: string; label: string };

const mk = (id: string, label = id): Item => ({ id, label });

function labels(target: Element): string[] {
  return [...target.querySelectorAll("li")].map((li) => li.textContent ?? "");
}

describe("For", () => {
  test("初期 list を render する", () => {
    const target = document.createElement("ul");
    const items = signal<Item[]>([mk("a"), mk("b"), mk("c")]);

    mount(() => {
      const li = (item: Item) => {
        const el = document.createElement("li");
        el.textContent = item.label;
        return el;
      };
      return For({ each: items, children: li });
    }, target);

    expect(labels(target)).toEqual(["a", "b", "c"]);
  });

  test("item 追加で DOM が足される", () => {
    const target = document.createElement("ul");
    const items = signal<Item[]>([mk("a")]);
    const renderItem = (item: Item) => {
      const el = document.createElement("li");
      el.textContent = item.label;
      return el;
    };
    mount(() => For({ each: items, children: renderItem }), target);
    expect(labels(target)).toEqual(["a"]);

    items.value = [mk("a"), mk("b"), mk("c")];
    // 新規 item は refs が違うので既存の "a" とも非一致: Map<T> の key が object ref
    // → この test では全入れ替え扱い
    expect(labels(target)).toEqual(["a", "b", "c"]);
  });

  test("同一参照の item は DOM を再利用する (state 保持)", () => {
    const target = document.createElement("ul");
    const a = mk("a");
    const b = mk("b");
    const c = mk("c");
    const items = signal<Item[]>([a, b, c]);

    const renderItem = (item: Item) => {
      const el = document.createElement("li");
      el.textContent = item.label;
      return el;
    };
    mount(() => For({ each: items, children: renderItem }), target);
    const before = target.querySelectorAll("li");
    const [, liB] = before;

    // b を真ん中から先頭に移動 — liB は同じ Node のはず
    items.value = [b, a, c];
    const after = target.querySelectorAll("li");
    expect(labels(target)).toEqual(["b", "a", "c"]);
    expect(after[0]).toBe(liB);
  });

  test("消えた item は DOM から除去され、owner も dispose される", () => {
    const target = document.createElement("ul");
    const a = mk("a");
    const b = mk("b");
    const items = signal<Item[]>([a, b]);

    let innerRunCount = 0;
    const external = signal(0);

    mount(
      () =>
        For({
          each: items,
          children: (item) => {
            // item の owner 配下に Effect を作り、external の更新で再実行される
            effect(() => {
              void external.value;
              innerRunCount++;
            });
            const el = document.createElement("li");
            el.textContent = item.label;
            return el;
          },
        }),
      target,
    );
    expect(innerRunCount).toBe(2); // a, b の初回実行

    // b を削除
    items.value = [a];
    expect(labels(target)).toEqual(["a"]);

    // external を更新 → 生きてる effect は a の 1 つだけのはず
    external.value = 1;
    expect(innerRunCount).toBe(3); // 2 (初回) + 1 (a のみ) = 3
  });

  test("空リストで fallback を表示、非空に戻すと fallback が外れる", () => {
    const target = document.createElement("div");
    const items = signal<Item[]>([]);
    const fb = document.createElement("p");
    fb.textContent = "empty";

    mount(
      () =>
        For({
          each: items,
          children: (item) => {
            const el = document.createElement("li");
            el.textContent = item.label;
            return el;
          },
          fallback: fb,
        }),
      target,
    );
    expect(target.textContent).toBe("empty");

    items.value = [mk("a")];
    expect(target.contains(fb)).toBe(false);
    expect(target.querySelector("li")?.textContent).toBe("a");

    items.value = [];
    expect(target.textContent).toBe("empty");
  });

  test("並び替え: 同じ item 群を順序だけ変更 → 全 DOM が再利用される", () => {
    const target = document.createElement("ul");
    const [a, b, c] = [mk("a"), mk("b"), mk("c")];
    const items = signal<Item[]>([a, b, c]);
    mount(
      () =>
        For({
          each: items,
          children: (item) => {
            const el = document.createElement("li");
            el.textContent = item.label;
            return el;
          },
        }),
      target,
    );
    const [liA, liB, liC] = target.querySelectorAll("li");

    items.value = [c, a, b];
    const after = target.querySelectorAll("li");
    expect(labels(target)).toEqual(["c", "a", "b"]);
    expect(after[0]).toBe(liC);
    expect(after[1]).toBe(liA);
    expect(after[2]).toBe(liB);
  });

  test("関数 each で依存追跡され、フィルタ結果に追従する", () => {
    const target = document.createElement("ul");
    const items = signal<Item[]>([mk("a"), mk("b"), mk("c")]);
    const showB = signal(true);
    mount(
      () =>
        For({
          each: () => items.value.filter((x) => showB.value || x.id !== "b"),
          children: (item) => {
            const el = document.createElement("li");
            el.textContent = item.label;
            return el;
          },
        }),
      target,
    );
    expect(labels(target)).toEqual(["a", "b", "c"]);

    showB.value = false;
    expect(labels(target)).toEqual(["a", "c"]);

    showB.value = true;
    expect(labels(target)).toEqual(["a", "b", "c"]);
  });

  test("mount dispose で anchor と全 item が掃除される", () => {
    const target = document.createElement("ul");
    const items = signal<Item[]>([mk("a"), mk("b")]);
    const dispose = mount(
      () =>
        For({
          each: items,
          children: (item) => {
            const el = document.createElement("li");
            el.textContent = item.label;
            return el;
          },
        }),
      target,
    );
    expect(target.children.length).toBe(2);
    dispose();
    // anchor も item も全部外れる
    expect(target.childNodes.length).toBe(0);
  });
});
