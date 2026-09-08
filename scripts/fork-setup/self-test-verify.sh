#!/usr/bin/env bash
# Самодоказательство `verify-fork-patches.sh` — он умеет краснеть (конвенция job `meta`).
#
# ⚠ Зачем это отдельный скрипт, а не «гоняем гейт на PR». Гейт проверяет ДЕРЕВО ФОРКА
# ЯДРА, которого в этом репозитории нет: его единственный вызов живёт в `build-kernel.yml`
# под `workflow_dispatch`, то есть до релизной сборки его никто не запускает. Две проверки
# можно было сломать и узнать об этом только на выкатке.
#
# Здесь строится МИНИМАЛЬНОЕ фиктивное дерево-двойник, на котором каждый обход, найденный
# критикой 06.09.2026, обязан покраснеть. Настоящие патчи это не проверяет — это проверяет,
# что сам прибор жив.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="${REPO_ROOT}/scripts/fork-setup/verify-fork-patches.sh"
WORK=$(mktemp -d)
trap 'rm -rf "${WORK}"' EXIT

fail=0
pass=0

# Дерево-двойник: только те файлы и маркеры, которые нужны проверяемым правилам.
# Гейт принимает КОРЕНЬ форка и сам добавляет `packages/opencode/src` — раскладку
# двойника надо повторить, иначе он честно скажет «это не корень форка» и выйдет с 2.
seed() {
  local root="$1"
  local dst="${root}/packages/opencode/src"
  mkdir -p "${dst}/cli/cmd" "${dst}/session" "${dst}/agent"
  cat > "${dst}/cli/cmd/run.ts" <<'TS'
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.once(sig, () => {
    void Promise.race([restoreRunOverrides()]).finally(() => process.exit(code))
  })
}
TS
  cat > "${dst}/session/prompt.ts" <<'TS'
const isBoundedComputation = isBoundedComputationAgent(agent)
TS
  cat > "${dst}/agent/bounded-computation.ts" <<'TS'
import { SYSTEM_SPAWNED_AGENT_TYPES } from "./config"
export const BOUNDED_COMPUTATION_AGENTS = new Set([...SYSTEM_SPAWNED_AGENT_TYPES])
TS
}

# Прогоняет гейт на дереве и требует, чтобы НАЗВАННАЯ проверка была в нужном состоянии.
expect_check() {
  local label="$1" dir="$2" check_name="$3" want="$4"   # want: red | green
  local out
  out=$(bash "${GATE}" "${dir}" 2>&1)
  local got="green"
  if printf '%s' "${out}" | grep -q "::error::\[${check_name}\]"; then got="red"; fi
  if [[ "${got}" == "${want}" ]]; then
    echo "  ✓ ${label}"
    pass=$((pass + 1))
  else
    echo "  ✗ ${label}: ожидалось ${want}, получено ${got}"
    printf '%s\n' "${out}" | grep -E "\[${check_name}\]" | head -2
    fail=$((fail + 1))
  fi
}

echo "== self-test verify-fork-patches: каждый известный обход обязан краснеть =="

D="${WORK}/clean"; seed "$D"
expect_check "чистое дерево-двойник: signal-must-exit зелёный" "$D" "track-r-signal-must-exit" green
expect_check "чистое дерево-двойник: bounded-call зелёный" "$D" "track-r-bounded-call" green

D="${WORK}/comment"; seed "$D"
cat > "${D}/packages/opencode/src/cli/cmd/run.ts" <<'TS'
for (const sig of ["SIGINT"] as const) {
  process.once(sig, () => {
    // раньше здесь был process.exit(code)
    void restoreRunOverrides()
  })
}
TS
expect_check "exit только в комментарии → красный" "$D" "track-r-signal-must-exit" red

D="${WORK}/string"; seed "$D"
cat > "${D}/packages/opencode/src/cli/cmd/run.ts" <<'TS'
for (const sig of ["SIGINT"] as const) {
  process.once(sig, () => {
    log.info("shutting down, was process.exit(code)")
  })
}
TS
expect_check "exit только в строковом литерале → красный" "$D" "track-r-signal-must-exit" red

D="${WORK}/second"; seed "$D"
cat >> "${D}/packages/opencode/src/cli/cmd/run.ts" <<'TS'
for (const sig of ["SIGUSR1"] as const) {
  process.once(sig, () => {
    void restoreRunOverrides()
  })
}
TS
expect_check "второй обработчик без exit → красный" "$D" "track-r-signal-must-exit" red

D="${WORK}/nocall"; seed "$D"
echo 'const isBoundedComputation = false' > "${D}/packages/opencode/src/session/prompt.ts"
expect_check "предикат определён, но не вызывается → красный" "$D" "track-r-bounded-call" red

D="${WORK}/inference"; seed "$D"
cat > "${D}/packages/opencode/src/session/prompt.ts" <<'TS'
const isBoundedComputation =
  agent?.native === true &&
  agent?.hidden === true
TS
expect_check "регрессия native+hidden, разбитая форматтером → красный" "$D" "track-r-no-native-hidden-inference" red

D="${WORK}/swapped"; seed "$D"
cat > "${D}/packages/opencode/src/session/prompt.ts" <<'TS'
const isBoundedComputation = agent?.hidden === true && agent?.native === true
TS
expect_check "та же регрессия с переставленными операндами → красный" "$D" "track-r-no-native-hidden-inference" red

D="${WORK}/handlist"; seed "$D"
echo 'export const BOUNDED_COMPUTATION_AGENTS = new Set(["title", "summary"])' > "${D}/packages/opencode/src/agent/bounded-computation.ts"
expect_check "рукописный список вместо реестра → красный" "$D" "track-r-bounded-from-registry" red

echo ""
if [[ "${fail}" -ne 0 ]]; then
  echo "::error::self-test-verify: ${fail} случаев не сработали (прошло ${pass})"
  exit 1
fi
echo "✓ self-test-verify: гейт краснеет на всех ${pass} случаях"
