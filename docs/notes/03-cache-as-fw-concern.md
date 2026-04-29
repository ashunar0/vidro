# Cache as fw concern — 薄い core + 厚い optional pack

> このノートは、Vidro が「cache 機能をどこまで内蔵するか」 についての設計判断と、
> その背景を整理したもの。`02-html-first-wire.md` で挙げた JSON exception を
> 少なくする手段としての cache、および TanStack Query / SWR との切り分け。

## 問題設定

modern web app には「server data の client-side cache」 が必須。例えば:

- 同じ data を複数 component で使う (重複 fetch を避けたい)
- mutation 後に関連 data を refetch したい (invalidation)
- mutation 中に画面に仮反映したい (optimistic update)
- tab 復帰時に最新 data に更新したい (refetch on focus)
- 大量 data をローカルで filter / sort したい (raw data へのアクセス)

これらは React / Vue 系では **TanStack Query / SWR / Apollo Client** に外注され
がち。Vidro はどうすべきか？

---

## TanStack Query / SWR が解決してる仕事の分解

| 機能                   | 何のため                                       |
| ---------------------- | ---------------------------------------------- |
| query key cache        | data の重複 fetch を防ぐ                       |
| dedupe                 | 並行 request を 1 本にまとめる                 |
| stale-while-revalidate | 古い cache を即返しつつ background で fresh 化 |
| optimistic update      | mutation 中に cache を仮更新、失敗で revert    |
| invalidation           | mutation 後に関連 cache を破棄                 |
| refetch on focus       | tab 切り替えで自動 refresh                     |
| garbage collection     | 不要 cache の解放                              |
| typed access           | TS 型と統合                                    |

これらは「**client 側に存在する server data の状態を管理する**」 という 1 つの
責務に収まる。

---

## 各 fw のアプローチ

| fw                     | アプローチ                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| React (素)             | 持たない。`useEffect` で fetch、cache は外注                                                                              |
| Next.js Pages Router   | server data だけ扱う、client cache は外注                                                                                 |
| **Next.js App Router** | 4 層 cache 内蔵 (Request Memoization / Data Cache / Full Route Cache / Router Cache) → **複雑すぎて批判される、反面教師** |
| Remix                  | loader 戻り値を cache、navigation で auto-revalidate。簡素方針                                                            |
| Solid Start            | `createAsync` + 軽量 cache、Solid-flavored                                                                                |
| TanStack Start         | TanStack Query をそのまま統合                                                                                             |

Vidro は **Remix / Solid Start に近い position** を取る。

---

## Vidro の design principle

### 原則

> **HTML-first wire を成立させるのに必要な最低限の cache は @vidro/router core
> に内蔵する。TanStack Query / SWR レベルの高度な cache 管理は、optional package
> (`@vidro/query` 仮称) で別途提供する。**

これは設計書の **2-layer product structure** (薄い core + 厚い optional pack)
と完全に整合する。

### 切り分け

#### @vidro/router (core) — 内蔵する最低限

HTML-first wire を成立させるのに **構造的に必要** なもの:

- **loader cache**: URL key、navigation で auto-revalidate
- **resource cache**: bootstrapKey 経由 (Phase B-5c で着地済)
- **dedupe**: 同 key の並行 fetch を 1 本化
- **mutation invalidation**: action 完了 → 関連 loader を refetch
- **optimistic update**: `resource.mutate(updater)` (Phase 4 step 2 で予定)
- **typed cache access**: `LoaderData<typeof loader>` を cache 経由で読む

理由: これらが無いと HTML-first wire が成立しない。例えば cache 無しだと
client-side filter のために毎回 JSON fetch する羽目になり、HTML-first 原則が
崩れる。

#### @vidro/query (仮) — opt-in で別 package

案件依存、必要なら個別 install:

- refetch on window focus / network online
- interval polling / background sync
- garbage collection policy (memory pressure)
- persistent cache (localStorage / IndexedDB / Cache API)
- 複雑な stale-while-revalidate 設定
- query key composition / 階層 invalidation
- prefetch API
- mutation queue / retry policy
- DevTools 連携

理由: これらは「あれば嬉しい」機能で、無くても fw として成立する。core に
入れると transparency / 薄さ が崩れる。

#### 外部 lib に任せる領域

- GraphQL 統合 (Apollo / urql / Houdini)
- offline-first sync (PowerSync / Replicache)
- IndexedDB の永続化詳細

---

## fine-grained reactivity との相性

VDOM 派 (React + TanStack Query) は cache を snapshot で返す:

```tsx
const { data } = useQuery({ queryKey: ["users"], queryFn: fetchUsers });
// data は snapshot、re-render trigger に依存
```

Vidro は cache を **signal で返せる**:

```ts
const users = useCache(loader); // ← Signal<User[]>
return <For each={users}>{u => <li>{u.name}</li>}</For>;

// cache 更新時 (action 完了 / mutate / invalidate)
// → fetcher 再実行 → signal value 更新 → effect 走る → DOM 自動更新
```

VDOM の場合 cache update → component re-render → diff → patch だが、Vidro は
**signal の update が直接 DOM に届く**。

これにより `useQuery` 級の重い API なしで cache 統合が成立する。fine-grained
reactivity の構造的優位を活かす形。

---

## HTML-first wire との関係

cache 内蔵は HTML-first wire の **JSON exception の数を減らす** 効果がある:

| exception                  | cache 無しの場合      | cache ありの場合                 |
| -------------------------- | --------------------- | -------------------------------- |
| action result (楽観的更新) | JSON 必要             | JSON 必要 (cache 仮更新の入力)   |
| 明示的 client data fetch   | JSON 必要             | 多くは cache hit、初回のみ JSON  |
| 細粒度 partial update      | JSON or HTML fragment | cache 経由で skip 可能なケース増 |

つまり cache は **HTML-first wire の missing piece** とも言える。cache が無いと
client-side data 加工のために毎回 JSON wire を要求して HTML-first 原則が崩れる。
cache がそれを吸収する。

---

## Vidro の現状 (Phase B-5c 着地時点)

実は Vidro は既に **原始的な cache** を持っている:

```ts
// bootstrap.ts (ADR 0030)
window.__vidroResources = { "posts:1": [...], "user:42": {...} };

// Resource constructor:
new Resource("posts:1", () => fetch(...))
// server: fetcher を scope に register
// client: __vidroResources["posts:1"] hit なら loading=false スタート、fetcher 呼ばず
```

これは事実上:

- **key**: bootstrapKey 文字列
- **value**: server fetch 結果
- **read API**: Resource constructor 内の bootstrap hit
- **invalidation**: navigation で `reloadCounter` → `refetch()`

= **read-only な session-scoped cache** が既にある。本ノートの principle は
これを発展させる方向の宣言。

---

## 設計判断の checklist

cache 関連の機能を追加検討するとき:

1. これは **HTML-first wire の成立に構造的に必要** か？
   - YES → core に内蔵 (例: dedupe、optimistic update)
   - NO → 進める
2. これは **多くの案件で必要** か？
   - YES → core に内蔵検討 (例: navigation 連動 invalidation)
   - NO → 進める
3. これは **opt-in が妥当な機能** か？
   - YES → @vidro/query (仮) に切り出す
   - NO → 進める
4. これは **外部 lib の領域** か？
   - YES → 外注、Vidro は touch しない

迷ったら **「より軽い core を選ぶ」** = `core 内蔵 < @vidro/query < 外注` の
順で重さを評価する。

---

## 関連

- `docs/notes/01-system-architecture.md` — 3 軸 × 3 層 × 3 boundary
- `docs/notes/02-html-first-wire.md` — wire format 設計、cache が JSON exception を吸収
- `docs/decisions/0028-create-resource.md` — resource primitive
- `docs/decisions/0030-resource-bootstrap.md` — server-side resource bootstrap (= 原始 cache)
- `docs/decisions/0037-action-primitive-remix-style-minimum.md` — mutation invalidation の起源
- 設計書 `~/brain/docs/エデン 設計書.md` — 2-layer product structure
