<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, but it invokes Vite through `vp dev` and `vp build`.

## Vite+ Workflow

`vp` is a global binary that handles the full development lifecycle. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

### Start

- create - Create a new project from a template
- migrate - Migrate an existing project to Vite+
- config - Configure hooks and agent integration
- staged - Run linters on staged files
- install (`i`) - Install dependencies
- env - Manage Node.js versions

### Develop

- dev - Run the development server
- check - Run format, lint, and TypeScript type checks
- lint - Lint code
- fmt - Format code
- test - Run tests

### Execute

- run - Run monorepo tasks
- exec - Execute a command from local `node_modules/.bin`
- dlx - Execute a package binary without installing it as a dependency
- cache - Manage the task cache

### Build

- build - Build for production
- pack - Build libraries
- preview - Preview production build

### Manage Dependencies

Vite+ automatically detects and wraps the underlying package manager such as pnpm, npm, or Yarn through the `packageManager` field in `package.json` or package manager-specific lockfiles.

- add - Add packages to dependencies
- remove (`rm`, `un`, `uninstall`) - Remove packages from dependencies
- update (`up`) - Update packages to latest versions
- dedupe - Deduplicate dependencies
- outdated - Check for outdated packages
- list (`ls`) - List installed packages
- why (`explain`) - Show why a package is installed
- info (`view`, `show`) - View package information from the registry
- link (`ln`) / unlink - Manage local package links
- pm - Forward a command to the package manager

### Maintain

- upgrade - Update `vp` itself to the latest version

These commands map to their corresponding tools. For example, `vp dev --port 3000` runs Vite's dev server and works the same as Vite. `vp test` runs JavaScript tests through the bundled Vitest. The version of all tools can be checked using `vp --version`. This is useful when researching documentation, features, and bugs.

## Common Pitfalls

- **Using the package manager directly:** Do not use pnpm, npm, or Yarn directly. Vite+ can handle all package manager operations.
- **Always use Vite commands to run tools:** Don't attempt to run `vp vitest` or `vp oxlint`. They do not exist. Use `vp test` and `vp lint` instead.
- **Running scripts:** Vite+ built-in commands (`vp dev`, `vp build`, `vp test`, etc.) always run the Vite+ built-in tool, not any `package.json` script of the same name. To run a custom script that shares a name with a built-in command, use `vp run <script>`. For example, if you have a custom `dev` script that runs multiple services concurrently, run it with `vp run dev`, not `vp dev` (which always starts Vite's dev server).
- **Do not install Vitest, Oxlint, Oxfmt, or tsdown directly:** Vite+ wraps these tools. They must not be installed directly. You cannot upgrade these tools by installing their latest versions. Always use Vite+ commands.
- **Use Vite+ wrappers for one-off binaries:** Use `vp dlx` instead of package-manager-specific `dlx`/`npx` commands.
- **Import JavaScript modules from `vite-plus`:** Instead of importing from `vite` or `vitest`, all modules should be imported from the project's `vite-plus` dependency. For example, `import { defineConfig } from 'vite-plus';` or `import { expect, test, vi } from 'vite-plus/test';`. You must not install `vitest` to import test utilities.
- **Type-Aware Linting:** There is no need to install `oxlint-tsgolint`, `vp lint --type-aware` works out of the box.

## CI Integration

For GitHub Actions, consider using [`voidzero-dev/setup-vp`](https://github.com/voidzero-dev/setup-vp) to replace separate `actions/setup-node`, package-manager setup, cache, and install steps with a single action.

```yaml
- uses: voidzero-dev/setup-vp@v1
  with:
    cache: true
- run: vp check
- run: vp test
```

## Review Checklist for Agents

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to validate changes.
<!--VITE PLUS END-->

---

# プロジェクト: エデン (Eden) — "僕が考える最強のフロントエンドFW"

「AI時代のフルスタックフロントエンドFW」を自作するプロジェクト。現在は **toy runtime 実装フェーズ** で、設計書に書かれた仕様を小さく実装しながら、「本当に使える仕様か」を実地で検証していく。

## 設計書 (canonical reference)

**`~/brain/docs/エデン 設計書.md`** — 設計の single source of truth。実装判断に迷ったら必ず参照する。

主要な設計決定 (抜粋):

- **5つの哲学**: Hono的透明性 / Solid的fine-grained reactivity / Clean Architecture層分離 / AI-native規約 / 型貫通
- **2-layer product structure**: Eden core (薄い、SolidStart相当) + architecture pack (厚い、Rails相当) を opt-in で選択
- **Reactive primitive**: `new Signal(0)` / `new Computed(() => ...)` / `new Effect(() => ...)`、読み書きは `.value` 統一
  - toy runtime 段階では `new Signal(0)` / `signal(0)` **両方の形式を export** する方針 (スケール時に判断)
- **JSX 一本化**: コンパイラの仕事は「JSX展開」と「JSX内 dynamic slot を effect で包む」の2つだけ
- **Server/Client boundary**: `.server.ts` / `.client.ts` / `.ts` 拡張子で表現 (`"use client"` は却下)
- **Routing**: directory-based、特殊ファイルは `index.tsx` / `layout.tsx` / `server.ts` の3種類のみ
- **4層**: `routes → application → domain ← infrastructure`、linter で依存方向強制
- **Primary target**: Cloudflare Workers (WinterCG 準拠)

## npm パッケージ名

コードネーム「Eden」は設計上の呼称。npm 公開を見据えた実パッケージは **`@vidro` scope** (仮) で進める。例: `@vidro/core`, `@vidro/router` 等。将来の改名余地を残す。

関連ドキュメント (brain 内):

- `AI時代のフロントエンドFW設計ノート` — reactivity 系譜・哲学・primitive 決断 (Session 1+2)
- `AI時代のフロントエンドFW プロジェクト-エデン` — 層分離・型貫通の深掘り (Session 3)
- `エデン target syntax` — target syntax の iteration ログ

## 実装方針

- **小さく作って動かす**: 一気に仕様を詰めず、primitive から段階的に。実装して動かして、不満が出たら設計書に戻る
- **設計書と実装の双方向**: 実装で見つけた論点は設計書の「未決」セクションにフィードバックする
- **YAGNI**: 設計書の全項目を最初から実装しようとしない。core primitive → JSX compile → routing... の順で
