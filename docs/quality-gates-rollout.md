# Staged quality-gates rollout

This repository already has full-repo quality gate scripts, but the global baseline is still too noisy to enforce zero warnings and 90% coverage everywhere at once.

## Active rollout policy

`quality:ci` now enforces **phase 1** instead of the full repository:

- repository-profile lint with warnings treated as errors
- coverage thresholds of **90% functions / 90% lines / 90% branches**

Typecheck remains a separate pipeline concern. The existing repository-wide typecheck baseline is not yet green enough to be part of the first staged rollout wave.

## Phase 1 scope

- strict lint scope:
  - `script/lint-gate.ts`
  - `packages/opencode/script/check-coverage.ts`
  - `packages/opencode/src/workflow/external-workflow-state.ts`
  - `packages/opencode/test/workflow/external-workflow-state.test.ts`
- coverage scope:
  - `packages/opencode/src/workflow/external-workflow-state.ts`

This scope was chosen because it gives the repository a real, green, enforceable starting point without pretending the wider workflow/runtime tree is already ready for the repository's most aggressive lint profile.

## Commands

### Active staged gate

```bash
bun run quality:ci
```

### Full aspirational gate

```bash
bun run quality:ci:full
```

`quality:ci:full` is expected to stay red until the wider workflow/runtime and repository-wide debt is reduced.

## Next rollout waves

1. Expand repository-profile zero-warning lint into more workflow leaf modules.
2. Add stricter plugin/category layers (`import`, `promise`, `node`, pedantic/style/restriction) once each new slice is clean enough to adopt them.
3. Split broad runtime tests into smaller stable files so coverage and reliability can be enforced per slice.
4. Promote additional slices into `.quality-gates.json` stages until the full gate becomes the default.
