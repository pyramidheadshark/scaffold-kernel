#!/usr/bin/env bash
# Verifies that Scaffold branding patches are correctly applied to source files.
# Run before building to catch regressions early.
set -euo pipefail

OPENCODE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../packages/opencode/src" && pwd)"
PASS=0
FAIL=0

check_absent() {
  local file="$1"
  local pattern="$2"
  local label="$3"
  if grep -q "$pattern" "$file" 2>/dev/null; then
    echo "  FAIL: $label found in $file"
    FAIL=$((FAIL + 1))
  else
    echo "  ok:   $label absent from $(basename "$file")"
    PASS=$((PASS + 1))
  fi
}

check_present() {
  local file="$1"
  local pattern="$2"
  local label="$3"
  if grep -q "$pattern" "$file" 2>/dev/null; then
    echo "  ok:   $label present in $(basename "$file")"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $label missing from $file"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== Scaffold branding verification ==="
echo ""

echo "-- logo.ts --"
# Exclude the SCAFFOLD-BRANDING marker comment itself from the check
check_absent  "$OPENCODE_DIR/cli/logo.ts" "^[^/]*Xiaomi"      "Xiaomi string (non-comment)"
check_absent  "$OPENCODE_DIR/cli/logo.ts" "^[^/]*\(MIMO\|MiMo\)" "MiMo string (non-comment)"
check_present "$OPENCODE_DIR/cli/logo.ts" "SCAFFOLD-BRANDING"  "SCAFFOLD-BRANDING marker"

echo ""
echo "-- theme.tsx --"
check_absent  "$OPENCODE_DIR/cli/cmd/tui/context/theme.tsx" "xiaomiOrange" "xiaomiOrange variable"
check_absent  "$OPENCODE_DIR/cli/cmd/tui/context/theme.tsx" "Xiaomi"       "Xiaomi string"
check_present "$OPENCODE_DIR/cli/cmd/tui/context/theme.tsx" "scaffoldTeal" "scaffoldTeal variable"

echo ""
echo "-- i18n/en.ts --"
check_absent  "$OPENCODE_DIR/cli/cmd/tui/i18n/en.ts" "MiMoCode\|MiMo Code" "MiMoCode string"
check_absent  "$OPENCODE_DIR/cli/cmd/tui/i18n/en.ts" '"Xiaomi"'             "Xiaomi label"

echo ""
echo "-- i18n/ru.ts --"
check_absent  "$OPENCODE_DIR/cli/cmd/tui/i18n/ru.ts" "Xiaomi" "Xiaomi string"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [[ $FAIL -gt 0 ]]; then
  echo "ERROR: Branding verification failed. Apply Scaffold patches before building."
  exit 1
fi
echo "All checks passed."
