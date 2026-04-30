// @vitest-environment node
// ADR 0049 — loaderData() / diff merge の挙動を直接検証する unit test。
// foldRouteTree を経由せずに internal API (`_setLayerIndex` / `_resetPageLoaderData`
// / `_diffMergeAllLayers`) を直叩きする。

import { describe, expect, test } from "vite-plus/test";
import { isSignal } from "@vidro/core";
import {
  _diffMergeAllLayers,
  _resetAllForServer,
  _resetPageLoaderData,
  _restoreLayerIndex,
  _setLayerIndex,
  loaderData,
} from "../src/loader-data";

// 共通 helper: layer index を立てて loaderData() を呼ぶ。test 終了時に reset。
function withLayer<T>(idx: number, fn: () => T): T {
  const prev = _setLayerIndex(idx);
  try {
    return fn();
  } finally {
    _restoreLayerIndex(prev);
  }
}

describe("loaderData()", () => {
  test("scope 外で呼ぶと throw", () => {
    _resetAllForServer();
    expect(() => loaderData()).toThrow(/outside a route render scope/);
  });

  test("loader 不在 layer (raw === undefined) で呼ぶと throw", () => {
    _resetPageLoaderData([undefined]);
    expect(() => withLayer(0, () => loaderData())).toThrow(/no loader data/);
    _resetAllForServer();
  });

  test("同 page 内で複数回呼んでも shared instance を返す (論点 4 α)", () => {
    _resetPageLoaderData([{ name: "zundamon" }]);
    const a = withLayer(0, () => loaderData<() => Promise<{ name: string }>>());
    const b = withLayer(0, () => loaderData<() => Promise<{ name: string }>>());
    expect(a).toBe(b);
    _resetAllForServer();
  });

  test("primitive raw は Signal として返る", () => {
    _resetPageLoaderData([42]);
    const data = withLayer(0, () => loaderData<() => Promise<number>>());
    expect(isSignal(data)).toBe(true);
    expect((data as unknown as { value: number }).value).toBe(42);
    _resetAllForServer();
  });
});

describe("diff merge — primitive root", () => {
  test("Signal の .value が更新される", () => {
    _resetPageLoaderData([7]);
    const data = withLayer(0, () => loaderData<() => Promise<number>>());
    expect((data as unknown as { value: number }).value).toBe(7);
    _diffMergeAllLayers([99]);
    expect((data as unknown as { value: number }).value).toBe(99);
    _resetAllForServer();
  });
});

describe("diff merge — object root", () => {
  test("既存 key の primitive 更新は同一 Signal の .value で行われる", () => {
    _resetPageLoaderData([{ name: "zundamon", age: 3 }]);
    const data = withLayer(0, () => loaderData<() => Promise<{ name: string; age: number }>>());
    const nameSignal = (data as Record<string, unknown>).name; // Signal<string>

    _diffMergeAllLayers([{ name: "ずんだもん", age: 4 }]);

    // identity 保持 (= 既存 effect が detach されない)
    expect((data as Record<string, unknown>).name).toBe(nameSignal);
    expect(((data as Record<string, unknown>).name as { value: string }).value).toBe("ずんだもん");
    expect(((data as Record<string, unknown>).age as { value: number }).value).toBe(4);
    _resetAllForServer();
  });

  test("source に無い key は削除される", () => {
    _resetPageLoaderData([{ a: 1, b: 2 }]);
    const data = withLayer(0, () => loaderData<() => Promise<{ a: number; b?: number }>>());
    _diffMergeAllLayers([{ a: 1 }]);
    expect("b" in (data as object)).toBe(false);
    _resetAllForServer();
  });

  test("新規 key は追加される (proxy set 経由で wrap)", () => {
    _resetPageLoaderData([{ a: 1 }]);
    const data = withLayer(0, () => loaderData<() => Promise<{ a: number; b?: number }>>());
    _diffMergeAllLayers([{ a: 1, b: 9 }]);
    expect(((data as Record<string, unknown>).b as { value: number }).value).toBe(9);
    _resetAllForServer();
  });

  test("nested object も再帰的に in-place merge される", () => {
    _resetPageLoaderData([{ user: { name: "a", age: 1 } }]);
    const data = withLayer(0, () =>
      loaderData<() => Promise<{ user: { name: string; age: number } }>>(),
    );
    const userProxy = (data as Record<string, unknown>).user;
    const nameSignal = (userProxy as Record<string, unknown>).name;

    _diffMergeAllLayers([{ user: { name: "b", age: 2 } }]);

    // user proxy も name Signal も identity 保持
    expect((data as Record<string, unknown>).user).toBe(userProxy);
    expect((userProxy as Record<string, unknown>).name).toBe(nameSignal);
    expect((nameSignal as { value: string }).value).toBe("b");
    expect(((userProxy as Record<string, unknown>).age as { value: number }).value).toBe(2);
    _resetAllForServer();
  });
});

describe("diff merge — array (id-keyed reconcile)", () => {
  test("既存 id 一致は in-place update、新 id は append、消えた id は remove", () => {
    type Note = { id: number; title: string };
    _resetPageLoaderData([
      {
        notes: [
          { id: 1, title: "a" },
          { id: 2, title: "b" },
        ],
      },
    ]);
    const data = withLayer(0, () => loaderData<() => Promise<{ notes: Note[] }>>());
    const notes = (data as Record<string, unknown>).notes as unknown[];

    // id=1 の elem proxy への ref を保持し、merge 後も identity 保持を確認する
    const note1Proxy = notes[0];
    const note1Title = (note1Proxy as Record<string, unknown>).title;

    // server 側から:
    //   id=1 (title 更新)
    //   id=3 (新規)
    // が来て、id=2 が消えるシナリオ
    _diffMergeAllLayers([
      {
        notes: [
          { id: 1, title: "a-updated" },
          { id: 3, title: "c" },
        ],
      },
    ]);

    expect((notes as { length: number }).length).toBe(2);
    expect(notes[0]).toBe(note1Proxy); // identity 保持
    expect((note1Title as { value: string }).value).toBe("a-updated");

    const note3 = notes[1] as Record<string, unknown>;
    expect((note3.id as { value: number }).value).toBe(3);
    expect((note3.title as { value: string }).value).toBe("c");
    _resetAllForServer();
  });

  test("空配列 → N 件追加でも動く", () => {
    type Note = { id: number; title: string };
    _resetPageLoaderData([{ notes: [] as Note[] }]);
    const data = withLayer(0, () => loaderData<() => Promise<{ notes: Note[] }>>());
    const notes = (data as Record<string, unknown>).notes as unknown[];

    _diffMergeAllLayers([
      {
        notes: [
          { id: 1, title: "a" },
          { id: 2, title: "b" },
        ],
      },
    ]);

    expect((notes as { length: number }).length).toBe(2);
    const note1 = notes[0] as Record<string, unknown>;
    expect((note1.title as { value: string }).value).toBe("a");
    _resetAllForServer();
  });

  test("source 順番で order 維持される", () => {
    type Note = { id: number; title: string };
    _resetPageLoaderData([
      {
        notes: [
          { id: 1, title: "a" },
          { id: 2, title: "b" },
          { id: 3, title: "c" },
        ],
      },
    ]);
    const data = withLayer(0, () => loaderData<() => Promise<{ notes: Note[] }>>());
    const notes = (data as Record<string, unknown>).notes as unknown[];

    // 逆順で来る
    _diffMergeAllLayers([
      {
        notes: [
          { id: 3, title: "c" },
          { id: 2, title: "b" },
          { id: 1, title: "a" },
        ],
      },
    ]);

    const ids = (notes as Array<Record<string, unknown>>).map(
      (n) => (n.id as { value: number }).value,
    );
    expect(ids).toEqual([3, 2, 1]);
    _resetAllForServer();
  });
});

describe("diff merge — array (index-based, no id field)", () => {
  test("primitive 配列は length 揃え + 各 index を Signal 経由で更新", () => {
    _resetPageLoaderData([{ tags: ["a", "b", "c"] }]);
    const data = withLayer(0, () => loaderData<() => Promise<{ tags: string[] }>>());
    const tags = (data as Record<string, unknown>).tags as unknown[];

    _diffMergeAllLayers([{ tags: ["x", "y"] }]);

    expect((tags as { length: number }).length).toBe(2);
    expect((tags[0] as { value: string }).value).toBe("x");
    expect((tags[1] as { value: string }).value).toBe("y");
    _resetAllForServer();
  });

  test("object 配列で id 無しは index ベースで再帰 merge", () => {
    _resetPageLoaderData([{ items: [{ name: "a" }, { name: "b" }] }]);
    const data = withLayer(0, () =>
      loaderData<() => Promise<{ items: Array<{ name: string }> }>>(),
    );
    const items = (data as Record<string, unknown>).items as unknown[];
    const item0Proxy = items[0];

    _diffMergeAllLayers([{ items: [{ name: "x" }, { name: "y" }, { name: "z" }] }]);

    expect((items as { length: number }).length).toBe(3);
    // index 0 の proxy は identity 保持 (= 既存 proxy への merge)
    expect(items[0]).toBe(item0Proxy);
    expect(((item0Proxy as Record<string, unknown>).name as { value: string }).value).toBe("x");
    _resetAllForServer();
  });
});

describe("layer reset と navigation", () => {
  test("_resetPageLoaderData で旧 stores は捨てられ、新 raws を wrap し直す", () => {
    _resetPageLoaderData([{ name: "old" }]);
    const beforeStore = withLayer(0, () => loaderData<() => Promise<{ name: string }>>());
    expect(((beforeStore as Record<string, unknown>).name as { value: string }).value).toBe("old");

    // 別 page への navigation を模す
    _resetPageLoaderData([{ name: "new" }]);
    const afterStore = withLayer(0, () => loaderData<() => Promise<{ name: string }>>());
    expect(afterStore).not.toBe(beforeStore); // 新 instance
    expect(((afterStore as Record<string, unknown>).name as { value: string }).value).toBe("new");
    _resetAllForServer();
  });
});
