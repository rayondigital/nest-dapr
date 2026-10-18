# Spike: pnpm + Turborepo

Branch: `spike/pnpm-turborepo` (from `main` @ `93c7e9f`, released as v0.11.6)

## Goal

Move the repo from npm workspaces to a pnpm workspace orchestrated by Turborepo, without changing what
consumers get from npm.

## Constraints

- **Only the library is published.** `examples/basics` is never published.
- **The published package must not change.** It stays CommonJS (`tsconfig` `module: commonjs`) with
  the same `main`/`types`, the same 114-file `dist/` layout, and the same `dependencies`/`peerDependencies`.
  Dual ESM/CJS is out of scope (see below).
- **Consumers aren't affected.** npm, yarn and pnpm users install exactly as today.
- **Tests run one spec file at a time**, in both modes (emulator and real sidecar). Each test must take
  under 1 minute.
- **Publishing keeps working from a `v*` tag**, with npm provenance.

## Current state (verified on `main`)

| Area | Today |
|---|---|
| Package manager | npm, `package-lock.json`, root `"workspaces": ["examples/basics"]` |
| Layout | Library at the repo root (`lib/`, `tests/`, `dist/`); example in `examples/basics` |
| Example → library link | `"@rayondigital/nest-dapr": "file:../.."` |
| Overrides | `"resolutions": { "whatwg-url": "^14.0.0" }` (npm ignores `resolutions`, so this needs checking) |
| Build | `rimraf -rf dist && tsc -p tsconfig.build.json` (excludes `lib/emulator`) |
| Tests | Jest via ts-jest, `rootDir: tests`; modes set with `DAPR_TEST_MODE` (`real` is the default, `emulator` is the alternative) |
| CI | Only `npm-publish.yml`, triggered by a `v*` tag: `npm ci`, build, `npm publish --provenance`. No PR checks. |
| Install scripts | Only `@nestjs/core` (opencollective banner) and `protobufjs` (postinstall) |
| Node | `.nvmrc` = `v18` (EOL), CI = 24, `engines` = `>=18`, example Dockerfile = `node:18-alpine` |

Known problems on `main` that this spike touches:
- `examples/basics/Dockerfile` can't build. It copies only the example directory, so `file:../..` doesn't
  resolve inside the build context.
- The publish workflow warns about deprecated Node 20 actions (`actions/checkout@v4`,
  `actions/setup-node@v4`), the `always-auth` npm config, and npm's restrictions on tokens that bypass 2FA.
- `ubuntu-latest` switches to Ubuntu 26 from 19 October 2026.

## Target layout

```
/                         private workspace root (tooling only, never published)
├─ package.json           "private": true, packageManager, turbo + shared dev tooling
├─ pnpm-workspace.yaml    packages/*, apps/*
├─ turbo.json
├─ README.md              canonical README (GitHub)
├─ packages/
│  └─ nest-dapr/          @rayondigital/nest-dapr — lib/, tests/, jest.config.js, tsconfig*.json
└─ apps/
   ├─ nest-10/            NestJS 10 example (was examples/basics), depends on "workspace:*"
   └─ nest-12/            NestJS 12 example (new, after the migration)
```

**Why move the library out of the root:** Turborepo treats the root as the workspace root. Root-level
tasks (`//#build`) are a limited escape hatch. They don't get per-package caching, filtering or `^build`
dependencies in the normal way. Moving the library into `packages/` is what makes Turbo worthwhile.

**Alternative:** pnpm only, with the library staying at the root and no Turbo. This is smaller and
lower-risk, but with one library and one example there's little left to orchestrate. Phase 1 below is
this alternative, so we can stop there if Turbo doesn't pay off.

## Phases

Each phase is its own commit (or commits) on the spike branch. Each one leaves the repo releasable.

### Phase 1: pnpm at the root (no layout change)

1. Pin pnpm with `"packageManager": "pnpm@<version>"` and enable Corepack.
2. Add `pnpm-workspace.yaml` (`examples/basics`) and remove the `"workspaces"` field.
3. Run `pnpm import` to generate `pnpm-lock.yaml` from `package-lock.json`, keeping the currently
   resolved versions. Then delete `package-lock.json`.
4. Move the `whatwg-url` pin from `"resolutions"` to `"pnpm": { "overrides": { ... } }`. First check
   whether npm ever applied it, so we know if this changes the resolution.
5. Change the example's dependency from `file:../..` to `"workspace:*"`.
6. Install scripts: pnpm 10 skips them unless they're listed in `onlyBuiltDependencies`. Decide for
   `@nestjs/core` (only a banner, so skip it) and `protobufjs`. Check that gRPC and workflows still
   work when it's skipped.
7. Change `npm run` to `pnpm` in scripts (`test:in-memory` runs `npm run test`) and in the README's
   Testing section.
8. Don't set `shamefully-hoist`. The strict layout is the point. It's what exposed the
   `@js-temporal/polyfill` bug fixed in 0.11.6.
9. Set `.nvmrc` to Node 24, and the example Dockerfile base image to `node:24-alpine`.
10. **Make the minimum publish-workflow change needed to stay releasable.** Removing
    `package-lock.json` breaks `npm ci`, so `npm-publish.yml` must switch to `pnpm/action-setup` and
    `pnpm install --frozen-lockfile`, then build with pnpm and run `npm publish --provenance`. Action
    version bumps and trusted publishing remain in Phase 3.

#### Phase 1 results (2026-10-18)

Implemented on this branch (uncommitted):
- `packageManager: pnpm@12.14.0`. The latest pnpm is 12.x, not 10.x.
- `pnpm-workspace.yaml` lists `examples/basics`, plus an `allowBuilds` denial for `@nestjs/core` and
  `protobufjs`. Both scripts were reviewed: one prints a funding banner, the other a version-range
  warning, and neither builds anything. pnpm 12 **fails** the install on unapproved build scripts
  (`ERR_PNPM_IGNORED_BUILDS`).
- `pnpm-lock.yaml` comes from `pnpm import`, and `package-lock.json` is removed. Resolved versions match
  apart from small patch-level differences in the example's `@nestjs/cli` build tooling (`minimatch`,
  `brace-expansion`, `webpack`).
- **`resolutions.whatwg-url` was dropped, not converted.** npm never applied it (`node-fetch@2.7.0`
  still resolved `whatwg-url@5.0.0`), so turning it into a pnpm override would have changed the
  install. If the aim was to avoid `node-fetch` 2's `punycode` deprecation warning, that needs a
  separate, deliberate decision. Also note that `lib/` imports neither `whatwg-url` nor `node-fetch`,
  even though both are runtime `dependencies`. Worth reviewing.
- The example depends on `workspace:*` and its scripts use `pnpm start`. `test:in-memory` uses `pnpm test`.
- `.nvmrc` is `v24`, and the example Dockerfile uses `node:24-alpine`. That Dockerfile still uses npm,
  and it was already broken (open question 1).
- `npm-publish.yml` now uses `pnpm/action-setup@v6`, then `pnpm install --frozen-lockfile`,
  `pnpm run build` and `npm publish --provenance`.
- The README has a new Development section, and its Testing section, the example README and the spec
  comments use pnpm commands.

Verified:
- A clean `pnpm install --frozen-lockfile` and `pnpm build` both work.
- The packed tarball has the same 114 files as the published 0.11.6, and `dist/` is **byte-identical**
  apart from line endings. A local Windows build has CRLF, while CI builds on Linux with LF.
  `package.json` differs only in the removed `workspaces` and `resolutions` fields and the
  `test:in-memory` script.
- `examples/basics` resolves the library from the workspace and builds (`nest build`).
- Lint shows 60 problems (42 errors, 18 warnings), **identical to `main` under npm**, so they predate
  this change. The `lint` script runs with `--fix`, which hides most of them.
- Every spec passes when run one at a time: 15 on the emulator (`dapr-workflow` needs gRPC) and all 16
  on a real sidecar (`dapr-tracing` is `describe.skip`). The slowest test takes 9.1 s, and the
  scheduler is left empty.

Found: **a pnpm 10 standalone install can't switch itself to pnpm 12.** A standalone pnpm 10
(`C:\Tools\pnpm.exe` 10.13) reads `packageManager` and tries to download `@pnpm/win-x64@12.14.0`.
pnpm 12 now publishes its standalone build only as `@pnpm/exe`, and the per-platform packages stop at
11.28.6, so `pnpm test:in-memory` fails with `ERR_PNPM_NO_MATCHING_VERSION`. CI (the `pnpm/action-setup`
npm package) and Corepack aren't affected. See open question 5.

### Phase 2: workspace layout + Turborepo

1. `git mv` the library into `packages/nest-dapr/` (`lib/`, `tests/`, `jest.config.js`, `tsconfig*.json`,
   `.npmignore`, `SDK.md`) and the example into **`apps/nest-10/`**. Using `git mv` keeps blame history.
   A new **`apps/nest-12/`** example follows.
2. Split `package.json`:
   - **Root:** `"private": true`, `packageManager`, `turbo`, shared dev tooling (eslint, prettier,
     typescript).
   - **`packages/nest-dapr`:** name, version, `main`/`types`/`files`, `dependencies`,
     `peerDependencies`, `publishConfig`, `engines`, and the library's own dev dependencies.
3. **README and LICENSE in the tarball:** npm packs the package's own directory, so the root README
   would be missing. Keep the root README canonical and copy `README.md` and `LICENSE` into the package
   in a `prepack` script. Alternatives are moving the README into the package (GitHub then shows a stub
   at the root) or a symlink (unreliable on Windows).
4. `turbo.json` tasks:
   - `build`: `outputs: ["dist/**"]`, cached
   - `lint`: cached
   - `test:unit`: specs with no sidecar (`compression`, `state-codec`, `stateful-actor-compression`,
     `workflow-endpoint`, `dapr-module`), cached on inputs
   - `test:emulator`: every spec except `dapr-workflow`, one spec per process, `cache: false` at first
   - `test:real`: every spec, one spec per process under `dapr run`, `cache: false`, manual only (never in CI)
   - In `apps/nest-10` (and later `apps/nest-12`), `build` depends on `^build`
5. **Codify one-spec-at-a-time:** add `packages/nest-dapr/scripts/run-specs.mjs`. It runs each
   `tests/*.spec.ts` in its own Jest process (wrapped in `dapr run` for real mode), prints a per-spec
   summary with timings, and fails on any failure or on any test over 60 s. This replaces the
   hand-written loops used while preparing 0.11.6.
6. Fix the example's Dockerfile with `turbo prune nest-10 --docker` (decision 6), building from the repo root.

### Phase 3: CI and publishing

1. Update `npm-publish.yml`, **keeping the filename**. An npm trusted-publisher configuration is tied
   to the workflow filename.
   - Use the current major versions of `actions/checkout` and `actions/setup-node`, with `cache: pnpm`.
   - Add `pnpm/action-setup`, then `pnpm install --frozen-lockfile`.
   - Run `pnpm turbo build --filter @rayondigital/nest-dapr`.
   - Publish from `packages/nest-dapr` with `npm publish --provenance`, the proven OIDC path.
   - Pin the runner image instead of `ubuntu-latest`, or accept the move to Ubuntu 26.
2. ~~Switch to npm trusted publishing~~ **Already in place.** The workflow uses no npm token secret,
   and `NODE_AUTH_TOKEN` was only setup-node's `XXXXX-…` placeholder, so releases already publish
   through OIDC. `actions/checkout` and `actions/setup-node` were bumped to v7 (`2d1917e`);
   setup-node v7 no longer sets that placeholder.
3. Add a **PR workflow** (`ci.yml`) that installs, then runs lint, build, `test:unit`, `test:emulator`
   and the pack check below. Real-sidecar tests stay manual (decision 7).
4. Add a **pack check** script that runs in CI. It runs `pnpm pack`, then:
   - compares the file list with the 0.11.6 tarball
   - installs the tarball into a temporary CommonJS project with pnpm `hoist=false` and peers installed
     explicitly
   - checks that `require()` works and that `tsc` passes (`skipLibCheck: false`, `strict: false`)

## Verification checklist (before merging the spike)

- [ ] `pnpm install --frozen-lockfile` works on a clean clone (Windows and Linux).
- [ ] The tarball's file list is identical to `@rayondigital/nest-dapr@0.11.6`. `package.json` differs
      only in version, with the same `dependencies` and `peerDependencies`.
- [ ] Strict consumer install: `require()` loads all exports, and `tsc` reports 0 errors with
      `skipLibCheck` on, and with it off when `strict` is false.
- [ ] Every spec passes one at a time on the emulator (except `dapr-workflow`) and on a real sidecar.
      Every test takes under 60 s, and the scheduler is empty afterwards.
- [ ] `apps/nest-10` builds and runs against the workspace package (`start:dapr:memory`).
- [ ] `npm publish --dry-run` from `packages/nest-dapr` shows the expected contents.
- [ ] A Turbo cache hit on a second `build` and `test:unit` run.
- [ ] README commands updated (install, Testing section, example paths).

## Decisions (2026-10-18)

1. **Scope:** Phase 1 first, then review (done). Phase 2 questions answered below.
2. **Example apps:** in Phase 2, `examples/basics` becomes **`apps/nest-10`**, the existing NestJS 10
   example. A new **`apps/nest-12`** example follows after the migration.
3. **README:** copy it into the package at `prepack` once the library moves to `packages/`. That's the
   normal monorepo approach, since npm packs the package directory's own README. In Phase 1 the library
   is still at the root, so the README is already included.
4. **Node:** use the current LTS, **Node 24**, for development, CI and the example image. Node 26
   doesn't become LTS until late October 2026.
5. **pnpm:** keep `pnpm@12.14.0`. Contributors upgrade a standalone pnpm to 12 or use Corepack. After
   upgrading, `pnpm test:in-memory` and `pnpm test:emulator` both pass.
6. **Example Dockerfile:** build with **`turbo prune nest-10 --docker`** from the repo root, so the image
   uses the workspace library, just like local runs.
7. **Real-sidecar tests:** **manual only**, never in automatic CI. Contributors run
   `pnpm test:in-memory` locally before merging. PR CI runs lint, build, unit and emulator specs.
8. **`apps/nest-10` dependencies:** upgrade the **tooling only** (TypeScript 5, `@types/node` 24,
   current `@typescript-eslint`) and keep every `@nestjs/*` package on 10.
9. **`engines`:** keep **`>=18`**, so nothing changes for consumers. Peer packages enforce their own
   minimums (Nest 11+ needs Node 20, nestjs-cls 7 needs 22, while `@dapr/dapr` 3.18 still allows 18).

Phase 1 is committed as `9eef54b`.

## Out of scope

- Dual ESM/CJS builds. They risk two copies of Nest DI tokens and decorator metadata.
- Dependency upgrades (Nest 11, TypeScript 5) beyond what the migration needs.
- Changesets or other release automation beyond the existing tag-based publish.
- Changes to the library's runtime code.
