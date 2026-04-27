// @vitest-environment jsdom
// ADR 0030 Step B-5c: readVidroData の cache 挙動。
//   - 初回 read: getElementById + JSON.parse + remove + cache
//   - 2 回目以降: cache から返す (DOM 触らない)
//   - script tag 無し / parse 失敗: null cache で確定
// ADR 0034 Issue 1 fix: window.__vidroResources からの merge。
//   - resources 既存 object に streaming patch を shallow merge
//   - resources field が無い navigation でも window patch を取り込んで作る

import { describe, expect, test, beforeEach } from "vite-plus/test";
import { readVidroData, __resetVidroDataCache } from "../src/bootstrap";

beforeEach(() => {
  __resetVidroDataCache();
  // 既存 script を全部剥がす (前 test の残骸排除)
  for (const el of Array.from(document.querySelectorAll("#__vidro_data"))) el.remove();
  // window patch の残骸排除
  delete (globalThis as { __vidroResources?: unknown }).__vidroResources;
});

describe("readVidroData", () => {
  test("初回 read: parse + remove + cache", () => {
    const script = document.createElement("script");
    script.id = "__vidro_data";
    script.type = "application/json";
    script.textContent = JSON.stringify({ pathname: "/x", resources: { foo: { data: 1 } } });
    document.head.appendChild(script);

    const data = readVidroData();
    expect(data).toEqual({ pathname: "/x", resources: { foo: { data: 1 } } });
    // remove されている
    expect(document.getElementById("__vidro_data")).toBeNull();
  });

  test("2 回目以降は cache から返す (DOM 触らない)", () => {
    const script = document.createElement("script");
    script.id = "__vidro_data";
    script.type = "application/json";
    script.textContent = JSON.stringify({ a: 1 });
    document.head.appendChild(script);

    const first = readVidroData();
    expect(first).toEqual({ a: 1 });

    // DOM から script は既に消えてるが、cache 経由で同じ値が返る
    const second = readVidroData();
    expect(second).toEqual({ a: 1 });
    expect(second).toBe(first); // 同一参照
  });

  test("script tag 無し: null cache で確定", () => {
    expect(readVidroData()).toBeNull();
    // 2 回目も null (cache 確定)
    expect(readVidroData()).toBeNull();
  });

  test("parse 失敗: null cache + script remove", () => {
    const script = document.createElement("script");
    script.id = "__vidro_data";
    script.type = "application/json";
    script.textContent = "not-json{";
    document.head.appendChild(script);

    expect(readVidroData()).toBeNull();
    expect(document.getElementById("__vidro_data")).toBeNull();
  });

  test("ADR 0034: window.__vidroResources を resources に shallow merge", () => {
    const script = document.createElement("script");
    script.id = "__vidro_data";
    script.type = "application/json";
    // 初期 resources (router 部分の bootstrap には resources 無いことが多いが、
    // ある場合は merge する形で test)
    script.textContent = JSON.stringify({
      pathname: "/x",
      resources: { existing: { data: "from-script" } },
    });
    document.head.appendChild(script);

    // streaming SSR の partial patch 相当を window object に貯めた状態
    (globalThis as { __vidroResources?: Record<string, unknown> }).__vidroResources = {
      streamed: { data: "from-stream" },
    };

    const data = readVidroData();
    expect(data?.resources).toEqual({
      existing: { data: "from-script" },
      streamed: { data: "from-stream" },
    });
  });

  test("ADR 0034: resources field 無し navigation でも window.__vidroResources で resources を作る", () => {
    const script = document.createElement("script");
    script.id = "__vidro_data";
    script.type = "application/json";
    script.textContent = JSON.stringify({ pathname: "/x", params: {} });
    document.head.appendChild(script);

    (globalThis as { __vidroResources?: Record<string, unknown> }).__vidroResources = {
      late: { data: "added" },
    };

    const data = readVidroData();
    expect(data?.resources).toEqual({ late: { data: "added" } });
  });
});
