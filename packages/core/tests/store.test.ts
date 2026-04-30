import { describe, expect, test, vi } from "vite-plus/test";
import { effect, signal, store, type Signal } from "../src/index";

describe("store (path F: leaf signal + 中間 proxy)", () => {
  describe("primitive 値", () => {
    test("primitive を渡すと Signal が返る", () => {
      // `store(0)` だと `Signal<0>` に narrowing されるので明示型注釈で widen
      const s = store<number>(0);
      expect(s).toBeInstanceOf(Object); // Signal インスタンス
      expect(s.value).toBe(0);
      s.value = 1;
      expect(s.value).toBe(1);
    });

    test("string も同様", () => {
      const s = store<string>("hello");
      expect(s.value).toBe("hello");
      s.value = "world";
      expect(s.value).toBe("world");
    });
  });

  describe("object", () => {
    test("field の primitive は leaf signal で読める", () => {
      const data = store({ count: 0, name: "vidro" });
      const count = data.count as unknown as Signal<number>;
      const name = data.name as unknown as Signal<string>;
      expect(count.value).toBe(0);
      expect(name.value).toBe("vidro");
    });

    test("field 直接代入で leaf signal が reactive 更新される", () => {
      const data = store({ count: 0 });
      const subscriber = vi.fn();
      const count = data.count as unknown as Signal<number>;
      count.subscribe(subscriber);
      // proxy 経由で primitive を書き込み → 既存 leaf signal に反映
      (data as unknown as { count: number }).count = 5;
      expect(count.value).toBe(5);
      expect(subscriber).toHaveBeenCalledWith(5);
    });

    test("nested object も再帰的に store 化される", () => {
      const data = store({ user: { name: "asahi", age: 24 } });
      const name = data.user.name as unknown as Signal<string>;
      expect(name.value).toBe("asahi");
      name.value = "asahi-changed";
      expect(name.value).toBe("asahi-changed");
    });

    test("動的 field 追加で primitive は signal 化される", () => {
      const data = store<Record<string, number>>({});
      (data as unknown as Record<string, number>).newField = 42;
      const f = data.newField as unknown as Signal<number>;
      expect(f.value).toBe(42);
    });

    test("destructure 罠が leaf で消える", () => {
      const data = store({ user: { name: "a", age: 1 } });
      // user は proxy、destructure しても proxy chain 維持
      const user = data.user;
      // leaf を destructure すると Signal が取れる → reactivity 維持
      const { name } = user as unknown as { name: Signal<string> };
      const subscriber = vi.fn();
      name.subscribe(subscriber);
      name.value = "b";
      expect(subscriber).toHaveBeenCalledWith("b");
    });
  });

  describe("array", () => {
    test("要素の primitive は leaf signal で読める", () => {
      const data = store([1, 2, 3]);
      const first = data[0] as unknown as Signal<number>;
      expect(first.value).toBe(1);
    });

    test("配列要素 (object) は proxy で wrap される", () => {
      const data = store([{ id: 1, title: "a" }]);
      const note = data[0];
      const id = note.id as unknown as Signal<number>;
      const title = note.title as unknown as Signal<string>;
      expect(id.value).toBe(1);
      expect(title.value).toBe("a");
    });

    test("push で要素追加、length が更新される", () => {
      // store は input として raw を期待するが、戻り型は wrapped (= push 引数も
      // wrapped を期待する形になり TS error)。`Store<T>` の write 用型は別論点
      // (= ADR 0047 の "API shape は実装時に詰める" の中)、ここは any 経由で回避。
      const data = store<{ id: number; title: string }[]>([]);
      // biome-ignore lint/suspicious/noExplicitAny: write-side 型は別論点 (ADR 0047 残課題)
      (data as any).push({ id: 1, title: "first" });
      expect(data.length).toBe(1);
      const first = data[0];
      const title = first.title as unknown as Signal<string>;
      expect(title.value).toBe("first");
    });

    test("push で追加した要素も leaf signal で reactive", () => {
      const data = store<{ id: number; title: string }[]>([]);
      // biome-ignore lint/suspicious/noExplicitAny: write-side 型は別論点 (ADR 0047 残課題)
      (data as any).push({ id: 1, title: "first" });
      const title = data[0].title as unknown as Signal<string>;
      const subscriber = vi.fn();
      title.subscribe(subscriber);
      title.value = "renamed";
      expect(subscriber).toHaveBeenCalledWith("renamed");
    });

    test("pop で要素削除、length が更新される", () => {
      const data = store([1, 2, 3]);
      const popped = data.pop() as unknown as Signal<number>;
      expect(popped.value).toBe(3);
      expect(data.length).toBe(2);
    });

    test("splice で挿入・削除", () => {
      const data = store([1, 2, 3]);
      // biome-ignore lint/suspicious/noExplicitAny: write-side 型は別論点 (ADR 0047 残課題)
      const removed = (data as any).splice(1, 1, 99, 100) as Signal<number>[];
      expect(removed.length).toBe(1);
      expect(removed[0].value).toBe(2);
      expect(data.length).toBe(4);
      expect((data[1] as unknown as Signal<number>).value).toBe(99);
      expect((data[2] as unknown as Signal<number>).value).toBe(100);
    });

    test("find は要素 (proxy) を返す", () => {
      const data = store([
        { id: 1, title: "a" },
        { id: 2, title: "b" },
      ]);
      const found = data.find((n) => (n.id as unknown as Signal<number>).value === 2);
      expect(found).toBeDefined();
      // optional chaining で短絡されると TypeError、上の toBeDefined で確認済 → non-null assertion
      const target = found as { title: unknown };
      expect(target.title as unknown as Signal<string>).toBeDefined();
      expect((target.title as unknown as Signal<string>).value).toBe("b");
    });
  });

  describe("effect 連動", () => {
    test("leaf signal の更新で effect が再実行される", () => {
      const data = store({ count: 0 });
      const fn = vi.fn();
      const e = effect(() => {
        fn((data.count as unknown as Signal<number>).value);
      });
      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith(0);
      (data as unknown as { count: number }).count = 5;
      expect(fn).toHaveBeenCalledTimes(2);
      expect(fn).toHaveBeenLastCalledWith(5);
      e.dispose();
    });

    test("array.push で iteration effect が再実行される", () => {
      const data = store<number[]>([]);
      const fn = vi.fn();
      const e = effect(() => {
        // length を読むことで配列の structural change を track
        fn(data.length);
      });
      expect(fn).toHaveBeenLastCalledWith(0);
      // biome-ignore lint/suspicious/noExplicitAny: write-side 型は別論点 (ADR 0047 残課題)
      (data as any).push(1);
      expect(fn).toHaveBeenLastCalledWith(1);
      // biome-ignore lint/suspicious/noExplicitAny: write-side 型は別論点 (ADR 0047 残課題)
      (data as any).push(2);
      expect(fn).toHaveBeenLastCalledWith(2);
      e.dispose();
    });

    test("動的 field 追加で Object.keys iteration effect が再実行される", () => {
      const data = store<Record<string, number>>({});
      const fn = vi.fn();
      const e = effect(() => {
        fn(Object.keys(data).length);
      });
      expect(fn).toHaveBeenLastCalledWith(0);
      (data as unknown as Record<string, number>).newField = 1;
      expect(fn).toHaveBeenLastCalledWith(1);
      (data as unknown as Record<string, number>).another = 2;
      expect(fn).toHaveBeenLastCalledWith(2);
      e.dispose();
    });

    test("既存要素の field 更新では length effect は再実行されない (= fine-grained 確認)", () => {
      const data = store([{ id: 1, title: "a" }]);
      const lengthFn = vi.fn();
      const titleFn = vi.fn();
      const lengthE = effect(() => {
        lengthFn(data.length);
      });
      const titleE = effect(() => {
        titleFn((data[0].title as unknown as Signal<string>).value);
      });
      expect(lengthFn).toHaveBeenCalledTimes(1);
      expect(titleFn).toHaveBeenCalledTimes(1);
      // title だけ更新
      const t = data[0].title as unknown as Signal<string>;
      t.value = "renamed";
      // title effect だけ走る、length effect は走らない (= fine-grained)
      expect(titleFn).toHaveBeenCalledTimes(2);
      expect(titleFn).toHaveBeenLastCalledWith("renamed");
      expect(lengthFn).toHaveBeenCalledTimes(1);
      lengthE.dispose();
      titleE.dispose();
    });
  });

  describe("identity / cache", () => {
    test("同じ raw を 2 回 wrap しても同じ proxy が返る", () => {
      const raw = { x: 1 };
      const a = store(raw);
      const b = store(raw);
      expect(a).toBe(b);
    });

    test("既に Signal な値を field に代入しても 2 重 wrap されない", () => {
      // Reviewer Critical 1: `data.x = signal(...)` 経路で Signal が proxy 化される
      // bug の regression 防止。Signal が再 wrap されると `existing instanceof Signal`
      // 判定が壊れて以降の reactive 書き込み path が死ぬ。
      const data = store<Record<string, unknown>>({});
      const externalSignal = signal(42);
      data.newField = externalSignal;
      expect(data.newField).toBe(externalSignal);
      // さらに primitive を代入 → 同じ signal が更新される (= reactive 維持)
      const subscriber = vi.fn();
      externalSignal.subscribe(subscriber);
      data.newField = 100;
      expect(externalSignal.value).toBe(100);
      expect(subscriber).toHaveBeenCalledWith(100);
    });
  });

  describe("signal との比較", () => {
    test("primitive store は直接 signal() と同等の挙動", () => {
      const s1 = store<number>(42);
      const s2 = signal(42);
      expect(s1.value).toBe(s2.value);
      s1.value = 100;
      s2.value = 100;
      expect(s1.value).toBe(s2.value);
    });
  });
});
