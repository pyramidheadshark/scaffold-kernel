#!/usr/bin/env bash
# scaffold fork-setup/verify-fork-patches.sh  (PI-80)
#
# Teeth на РЕАЛЬНОМ пути сборки. build-kernel.yml клонирует форк по тегу и собирает
# из его git-состояния — снимки .patched в сборке НЕ участвуют. Источник правды =
# git-история форка pyramidheadshark/scaffold-kernel, .patched = reference-only.
#
# Проблема, которую закрывает скрипт (PI-80): если форк когда-нибудь будет пересоздан
# из НЕПОЛНЫХ .patched (там нет session/prompt.ts goalGate и session/goal.ts
# Goal.Service), сборка молча выпустит ядро с НЕМЫМ Outcome Gate — goalGate
# отсутствует, а goal tool падает "Service not found: @opencode/SessionGoal" на
# старте реестра. --version этого не ловит (печатается до сборки ToolRegistry).
#
# Скрипт ассертит присутствие критических Scaffold-патчей в собираемом дереве. Любой
# отсутствующий маркер → exit 1 с явным сообщением, ДО дорогой сборки. Это та же
# дисциплина «проверять реальный путь, а не вестигиальный снимок», что в gate-ах
# scaffold/hub.
#
# Использование:
#   bash verify-fork-patches.sh [--strict] <путь-к-корню-форка>
#   (путь по умолчанию — текущая директория)
#
# --strict: дополнительно сверяет фактическое число прогнанных check/check_absent
# с EXPECTED_CHECK_COUNT ниже. Ловит класс регрессии «проверку тихо закомментировали
# или удалили, verify-fork-patches.sh всё ещё зелёный, потому что оставшиеся
# проверки прошли» — сам факт "0 ошибок" не доказывает "проверено всё, что должно".

set -euo pipefail

EXPECTED_CHECK_COUNT=63
STRICT=0
FORK_ROOT="$(pwd)"
for arg in "$@"; do
  case "$arg" in
    --strict) STRICT=1 ;;
    *) FORK_ROOT="$arg" ;;
  esac
done

SRC="$FORK_ROOT/packages/opencode/src"

if [[ ! -d "$SRC" ]]; then
  echo "::error::verify-fork-patches: не найден $SRC — это не корень форка scaffold-kernel?"
  exit 2
fi

fail=0
check_count=0

# check <человекочитаемое-имя> <файл> <grep-ERE-маркер> <почему-критично>
check() {
  local name="$1" file="$2" marker="$3" why="$4"
  local path="$SRC/$file"
  check_count=$((check_count + 1))
  if [[ ! -f "$path" ]]; then
    echo "::error::[$name] ОТСУТСТВУЕТ ФАЙЛ $file — $why"
    fail=1
    return
  fi
  if ! grep -Eq -- "$marker" "$path"; then
    echo "::error::[$name] маркер не найден в $file (/$marker/) — $why"
    fail=1
    return
  fi
  echo "✓ [$name] $file"
}

# check_in_block <имя> <файл> <ERE-маркер-начала-блока> <ERE-маркер> <почему-критично>
#
# ⚠ Заведено 06.09.2026 по находке собственной критики. `check` грепает ФАЙЛ ЦЕЛИКОМ, и
# гейт `track-r-signal-must-exit`, поставленный ровно чтобы отличить «обработчик есть» от
# «обработчик завершает процесс», зеленел на упоминании `process.exit(code)` в КОММЕНТАРИИ:
# реальный вызов был убран, гейт остался зелёным. Тот же класс, что и его предшественник,
# только строкой ниже: подстрока в файле ≠ поведение в блоке.
#
# Здесь маркер ищется только внутри блока, открытого первым маркером и закрытого по
# балансу фигурных скобок — то есть внутри тела конструкции, а не где-то рядом с ней.
check_in_block() {
  local name="$1" file="$2" block_start="$3" marker="$4" why="$5"
  local path="$SRC/$file"
  check_count=$((check_count + 1))
  if [[ ! -f "$path" ]]; then
    echo "::error::[$name] ОТСУТСТВУЕТ ФАЙЛ $file — $why"
    fail=1
    return
  fi
  # ⚠ Проверяются ВСЕ вхождения блока, а не первое. Мутация «исходный обработчик цел,
  # добавлен второй, для SIGUSR1/2, без exit» проходила мимо гейта: он смотрел только на
  # первый и был доволен. Достаточно одного блока без маркера, чтобы поведение сломалось.
  local block
  block=$(awk -v start="$block_start" '
    BEGIN { depth = 0; inblock = 0; blocks = 0 }
    # Подстрока, а не регексп: awk-regex и grep-ERE экранируются по-разному, и держать
    # один шаблон в двух диалектах — источник тихого расхождения.
    !inblock && index($0, start) > 0 { inblock = 1; depth = 0; blocks++; print "\036BLOCK" }
    inblock {
      line = $0
      # Порядок обязателен: СНАЧАЛА зануляем строковые литералы, потом вырезаем
      # комментарии, и только потом считаем скобки и ищем маркер.
      #
      # ⚠ Первая версия вырезала только комментарии, и обход стоил одной кавычки:
      # `Log.info("… process.exit(code) …")` удовлетворял гейт при удалённом вызове.
      # Вторая беда того же места — `//` внутри строкового литерала (URL): вырезание
      # комментария съедало хвост строки вместе со скобками, баланс рушился, и блок
      # уезжал на десятки строк вперёд, подхватывая маркер из чужого кода.
      gsub(/"[^"]*"/, "\"\"", line)
      gsub(/'"'"'[^'"'"']*'"'"'/, "'"'"''"'"'", line)
      gsub(/`[^`]*`/, "``", line)
      sub(/\/\/.*$/, "", line)
      gsub(/\/\*[^*]*\*\//, "", line)
      print line
      n = gsub(/\{/, "{", line); m = gsub(/\}/, "}", line)
      depth += n - m
      if (depth <= 0 && n + m > 0) inblock = 0
    }
  ' "$path")
  if [[ -z "$block" ]]; then
    echo "::error::[$name] блок /$block_start/ не найден в $file — $why"
    fail=1
    return
  fi
  local total=0 missing=0 current=""
  while IFS= read -r ln; do
    if [[ "$ln" == $'\036BLOCK' ]]; then
      if [[ "$total" -gt 0 ]] && ! printf '%s' "$current" | grep -Eq -- "$marker"; then
        missing=$((missing + 1))
      fi
      total=$((total + 1))
      current=""
      continue
    fi
    current+="$ln"$'\n'
  done <<< "$block"
  if [[ "$total" -gt 0 ]] && ! printf '%s' "$current" | grep -Eq -- "$marker"; then
    missing=$((missing + 1))
  fi
  if [[ "$missing" -gt 0 ]]; then
    echo "::error::[$name] маркер /$marker/ отсутствует в $missing из $total блоков /$block_start/ в $file — $why"
    fail=1
    return
  fi
  echo "✓ [$name] $file (во всех $total блоках)"
}

# check_absent_normalized <имя> <файл> <ERE> <почему>
#
# То же, что check_absent, но по тексту, склеенному в ОДНУ строку. `grep -E` построчный,
# а форматтер разбивает длинные условия по операторам — из-за этого негативная проверка,
# привязанная к дословной записи, выключается переформатированием и молчит на живой
# регрессии. Проверено: из пяти эквивалентных форм одного и того же условия построчный
# греп ловил одну.
check_absent_normalized() {
  local name="$1" file="$2" marker="$3" why="$4"
  local path="$SRC/$file"
  check_count=$((check_count + 1))
  if [[ ! -f "$path" ]]; then
    echo "::error::[$name] ОТСУТСТВУЕТ ФАЙЛ $file — $why"
    fail=1
    return
  fi
  if tr '\n' ' ' < "$path" | grep -Eq -- "$marker"; then
    echo "::error::[$name] запрещённый маркер НАЙДЕН в $file (/$marker/, поиск по склеенному тексту) — $why"
    fail=1
    return
  fi
  echo "✓ [$name] $file (запрещённый маркер отсутствует, проверено по склеенному тексту)"
}

# check_absent <имя> <файл> <grep-ERE-маркер> <почему-критично>
# Негативная проверка — отсутствие ФАЙЛА тоже провал (иначе "нет входа" тривиально
# удовлетворяет "маркер отсутствует", воспроизводя дефект бывшего
# spike-tests/p3a-branding.test.ts: readSource() на несуществующий файл возвращал
# "", и все `not.toContain` проходили на пустой строке — "зелено на пустоте").
check_absent() {
  local name="$1" file="$2" marker="$3" why="$4"
  local path="$SRC/$file"
  check_count=$((check_count + 1))
  if [[ ! -f "$path" ]]; then
    echo "::error::[$name] ОТСУТСТВУЕТ ФАЙЛ $file — $why"
    fail=1
    return
  fi
  if grep -Eq -- "$marker" "$path"; then
    echo "::error::[$name] запрещённый маркер НАЙДЕН в $file (/$marker/) — $why"
    fail=1
    return
  fi
  echo "✓ [$name] $file (запрещённый маркер отсутствует)"
}

echo "[verify-fork-patches] Проверяю критические Scaffold-патчи в $SRC"

# --- Outcome Gate ядро (PI-62) — главный риск молчаливого дрейфа ---
# Проверяем НЕ только определения, но и реальные точки ИСПОЛЬЗОВАНИЯ — иначе verifier
# даёт false-pass (критика PI-80: определение goalGate без вызова / импорт GoalTool без
# регистрации = немой Gate при зелёном verifier).
check "goalGate-def"    "session/prompt.ts" "SessionPrompt\.goalGate" \
  "определение энфорсмента Outcome Gate в main TUI; без него Gate отсутствует"
check "goalGate-call"   "session/prompt.ts" "yield\* goalGate\(lastUser\)" \
  "ВЫЗОВ goalGate в runLoop; определение без вызова = немой no-op (false-pass)"
check "goalGate-wired"  "session/prompt.ts" "Goal\.defaultLayer" \
  "goalGate должен иметь Goal-слой в defaultLayer prompt.ts, иначе runtime-разрыв"
check "Goal.Service"    "session/goal.ts"   "@opencode/SessionGoal" \
  "Goal.Service identity; без него GoalTool падает 'Service not found' на старте реестра"
check "Goal.evaluate"   "session/goal.ts"   "readonly evaluate:" \
  "judge-оценка цели; ядро ReAct-цикла goalGate"
check "Goal.verdict-strict" "session/goal.ts" "impossible: z\.boolean\(\)\.nullable\(\)" \
  "v0.1.21: Verdict.impossible nullable (не optional) — иначе codex strict 400 на judge → goalGate всегда fail-open (Outcome Gate = no-op под gpt-5.5)"
check "Goal.layer-def"  "session/goal.ts"   "export const defaultLayer" \
  "Goal.defaultLayer должна экспортироваться из goal.ts; иначе provide в prompt/registry мёртв"
check "GoalTool"        "tool/goal.ts"      "export const GoalTool" \
  "нативный tool goal — единственный способ вооружить Gate из main TUI"
check "GoalTool-init"   "tool/registry.ts"  "Tool\.init\(goaltool\)" \
  "РЕАЛЬНАЯ инициализация GoalTool в map реестра; импорт без init = goal tool недоступен (false-pass)"
check "Goal-layer-reg"  "tool/registry.ts"  "Goal\.defaultLayer" \
  "PI-69 hotfix: общий Goal-слой в реестре, иначе main TUI крашится на старте"

# --- PI-79 #1 (v0.1.15): измеримость fail-open goalGate ---
check "GateOutcome"     "session/goal.ts"   "export const GateOutcome" \
  "PI-79 #1: тип измеримого исхода gate; без него fail-open снова немой no-op"
check "gate-classified" "session/prompt.ts" "result: \"fail_open\"" \
  "PI-79 #1: классификация stop-решения goalGate проставлена; иначе дашборд Фазы O слеп"

# --- gpt-5.5/5.6 allowlist codex-loader — СНЯТО 31.08.2026 при ре-базлайне (scaffold-v0.1.28) ---
# Апстрим убрал весь механизм allowedModels-фильтрации из plugin/codex.ts за дрейфом до
# актуального upstream/main (подтверждено чтением чистого файла на новой базе) —
# CodexAuthPlugin.loader больше не строит allowedModels Set вообще, только зануляет cost
# и обрабатывает refresh. Значит любой bundled-слаг (включая gpt-5.6-{sol,terra,luna})
# экспонируется без прунинга — проверять больше нечего, бэкенд решает доступность сам.
# См. ~/.claude/plans/imperative-weaving-wand.md, таблица "Пробное переналожение", патч 0015
# (там же изначально предсказано это устаревание, до фактической выкатки ре-базлайна).

# --- PRIME-2 (v0.1.20): запрет actor spawn general в hub-режиме ---
check "prime2-guard"    "tool/actor.ts"     "SCAFFOLD_HUB_MODE" \
  "v0.1.20 PRIME-2: guard в actor.ts блокирует spawn general при SCAFFOLD_HUB_MODE=1; без него prime сваливает диагностику в general"

# --- PRIME-3 (v0.1.20): авто-армирование Outcome Gate goal ---
check "prime3-config"   "config/config.ts"  "autoGoalCondition" \
  "v0.1.20 PRIME-3: поле experimental.autoGoalCondition в схеме config; без него scaffold не может вооружить goalGate из kernel.json"
check "prime3-arm"      "session/prompt.ts" "goal\.set\(sessionID, autoGoalCondition\)" \
  "v0.1.20 PRIME-3: РЕАЛЬНЫЙ вызов goal.set из autoGoalCondition в runLoop; поле без вызова = немой no-op (false-pass)"

# --- Брендинг (перенесено из spike-tests/p3a-branding.test.ts, PI-129 Фаза 3 —
# тест читал ВЕНДОРЕННЫЙ снапшот через readSource(), который на отсутствующий файл
# возвращал "" и все `not.toContain` тривиально проходили; здесь тот же класс
# отсутствия входа = fail через общий check()/check_absent()) ---
check "branding-ru"     "cli/cmd/tui/i18n/ru.ts" "Scaffold" \
  "Scaffold-брендинг в локализации; отсутствие = форк собран без scaffold-патчей вообще"

check "logo-scaffold"        "cli/logo.ts" "Scaffold" \
  "ASCII-лого должно упоминать Scaffold"
check_absent "logo-no-xiaomi"     "cli/logo.ts" "Xiaomi" \
  "ASCII-лого не должно содержать Xiaomi"
check_absent "logo-no-mimo-code"  "cli/logo.ts" "MiMo CODE|MIMO CODE" \
  "ASCII-лого не должно содержать старое название ядра MiMo CODE"
check_absent "logo-no-mimo-thin"  "cli/logo.ts" "MIMO|CODE" \
  "тонкий вариант лого (half-block art) не должен содержать буквы MIMO/CODE"

check "logo-tsx-teal"        "cli/cmd/tui/component/logo.tsx" "SCAFFOLD_TEAL" \
  "цветовая константа лого должна называться SCAFFOLD_TEAL"
check_absent "logo-tsx-no-mimo-color" "cli/cmd/tui/component/logo.tsx" "MIMO_ORANGE|MIMO_GRAY" \
  "старые цветовые константы MiMo не должны остаться в лого"

check "theme-scaffold-teal"  "cli/cmd/tui/context/theme.tsx" "scaffoldTeal" \
  "тема должна использовать scaffoldTeal"
check_absent "theme-no-xiaomi-orange" "cli/cmd/tui/context/theme.tsx" "xiaomiOrange" \
  "тема не должна ссылаться на старую константу xiaomiOrange"

check_absent "ru-no-mimocode"     "cli/cmd/tui/i18n/ru.ts" "MiMoCode" \
  "русская локализация не должна упоминать MiMoCode"
check_absent "ru-no-mimo-code-sp" "cli/cmd/tui/i18n/ru.ts" "MiMo Code" \
  "русская локализация не должна упоминать 'MiMo Code'"
check "ru-openrouter"        "cli/cmd/tui/i18n/ru.ts" "OpenRouter" \
  "русская локализация должна упоминать OpenRouter как альтернативный провайдер"
check_absent "ru-no-free-mimo-tip" "cli/cmd/tui/i18n/ru.ts" "Бесплатные модели доступны" \
  "подсказка про бесплатные MiMo-модели не должна остаться в локализации"

check_absent "en-no-mimocode"     "cli/cmd/tui/i18n/en.ts" "MiMoCode" \
  "английская локализация не должна упоминать MiMoCode"
check_absent "en-no-mimo-code-sp" "cli/cmd/tui/i18n/en.ts" "MiMo Code" \
  "английская локализация не должна упоминать 'MiMo Code'"

check_absent "dialog-agreement-no-xiaomimimo" "cli/cmd/tui/component/dialog-agreement.tsx" "xiaomimimo\.com" \
  "соглашение не должно ссылаться на xiaomimimo.com"
check_absent "dialog-agreement-no-mi-privacy" "cli/cmd/tui/component/dialog-agreement.tsx" "privacy\.mi\.com" \
  "соглашение не должно ссылаться на privacy.mi.com"

check_absent "dialog-mimo-login-no-xiaomi-opt" "cli/cmd/tui/component/dialog-mimo-login.tsx" "value: \"xiaomi\"" \
  "диалог логина не должен предлагать опцию xiaomi OAuth"

check_absent "app-no-mimo-xiaomi-url" "cli/cmd/tui/app.tsx" "mimo\.xiaomi\.com" \
  "app.tsx не должен содержать URL mimo.xiaomi.com"

# PI-129 (Фаза 8, критическая находка 29.08.2026): raw CLI-команда `providers login`
# (алиас `auth login`, достижима через `scaffold auth login` — Scaffold не перехватывает
# `auth` как своё подкоманду, форвардит напрямую в бинарь ядра) предлагала интерактивное
# меню "MiMo" / "MiMo Auto (free)" с hint "recommended", ведущее на логин в Xiaomi.
# Отдельный путь от уже проверенного dialog-mimo-login.tsx (TUI-диалог) — та же утечка
# бренда, но в другом UI-слое, не покрытом существующими 35 проверками.
check_absent "providers-cli-no-xiaomi-mimo-menu" "cli/cmd/providers.ts" "\"MiMo\", value: \"xiaomi\"" \
  "raw CLI providers/auth login не должен предлагать пункт меню MiMo/Xiaomi"

# PI-102 (31.08.2026): SessionProcessor.cleanup безусловно ждал только 250ms in-flight
# tool call перед force-abort, даже когда cleanup запущен из-за только что обнаруженного
# overflow — слишком коротко для реально ещё выполняющегося тула (bash/MCP/файловый I/O),
# что приводило к torn transcript (aborted tool-part + продолжающийся в фоне side effect)
# и server_error на следующем запросе. Фикс — новый флаг с расширенным грейс-периодом
# ТОЛЬКО для overflow-пути; остальные причины cleanup (interrupt/error/blocked/normal)
# сохраняют исходные 250ms.
check "pi-102-overflow-toolcall-grace" "flag/flag.ts" "MIMOCODE_OVERFLOW_TOOLCALL_GRACE_MS" \
  "overflow cleanup обязан ждать in-flight tool call дольше безусловных 250ms"

# PI-129 (30-31.08.2026): компактный exec-dispatcher для GPT/Codex моделей — сворачивает
# полный tools() в один {id:"exec", parameters:{tool,args}}, обходя MessageOutputLengthError
# на тяжёлых tool-schema payload'ах. Заодно этим PR исправлен латентный typecheck-долг форка
# (41→0 ошибок), включая split .pipe() ToolRegistry.defaultLayer и GoalTool.execute metadata
# discriminated union — обе точки трогают тот же файл/область, что и Goal-layer-reg выше,
# поэтому отдельный check ловит именно регресс dispatcher-функции, не полагаясь на неё же.
# --- exec-dispatcher (PI-129) — СНЯТО 31.08.2026 при ре-базлайне (scaffold-v0.1.28) ---
# Наш custom exec-dispatcher полностью вытеснен собственным механизмом апстрима:
# tool/tool-script-ref.ts экспортирует GPT_TOP_LEVEL_TOOLS = new Set(["exec", "wait"]) —
# ТОТ ЖЕ компактный top-level tool-surface для GPT-моделей (registry.ts:
# availableTools.filtered.filter(tool => GPT_TOP_LEVEL_TOOLS.has(tool.id)) при
# useGPTTools && !includeHidden), встроенный в полноценный tool_script QuickJS-sandbox
# (программная оркестровка тулов), не наш минимальный 1:1-диспетчер. usesGPTToolset()/
# isGPTModel() (tool/gpt.ts) корректно матчит gpt-5.6-{sol,terra,luna} (substring "gpt",
# исключение "gpt-oss") — детекция модели не хуже нашей. Ничего проверять не нужно:
# это теперь код апстрима, а не наш патч.

# PI-134 (31.08.2026): builtin tool calls (apply_patch/write/edit/bash/...) вызванные
# ИЗНУТРИ exec (единственный top-level tool-surface для GPT/Codex-моделей) звали
# def.execute() напрямую, минуя plugin.trigger("tool.execute.before"/"after", ...) —
# в отличие от соседней MCP-ветки. Следствие: все plugin-side write-гейты (delegation
# enforcement, secret-write guard, TDD/Outcome-gate write detection) были слепы к
# builtin-тулам под GPT/Codex-моделями. Живой репро подтвердил ещё более тяжёлое
# следствие того же корня: Gate 1 (даунстрим scaffold-плагин) навсегда блокировал
# КАЖДЫЙ вызов exec целиком, поскольку вложенный scaffold_session_start никогда не
# успевал выполниться — perma-deadlock, prime зависал на первом же tool call.
check "pi-134-exec-plugin-hooks" "tool/tool-script.ts" "const plugin = yield\* Plugin.Service" \
  "builtin-тулы внутри exec обязаны идти через plugin.trigger, иначе все write-гейты слепы под GPT-моделями"

# Трек Q: локализация заголовка блока рассуждений. Раньше "Thinking:"/"Thought" были
# захардкожены латиницей без i18n-ключей вовсе — единственная английская строка,
# повторявшаяся на каждом шаге агента в полностью русскоязычном интерфейсе.
check "track-q-reasoning-i18n" "cli/cmd/tui/i18n/ru.ts" "tui.session.reasoning.thought" \
  "лейбл блока рассуждений обязан идти через i18n, иначе интерфейс снова станет частично английским"

# Трек Q: устранение холостых снапшотов на finish-step. Если patch.files пуст, дерево
# не менялось и write-tree вернул бы ровно ctx.snapshot — 73% вызовов track() были
# арифметически тождественными no-op (3625 patch-партов на 13553 step-finish).
check "track-q-snapshot-noop" "session/processor.ts" "pendingPatch" \
  "снимок на finish-step обязан вычисляться только когда файлы реально менялись"

# ─── Трек R (scaffold-v0.1.32): три патча одним релизом ──────────────────────
#
# Каждый закрывает механизм, который существовал, выглядел работающим и не
# работал. Проверяются ОБЕ стороны каждого — определение и точка вызова:
# определение без вызова — это ровно тот false-pass, ради которого написан
# --strict.

# R-1. headless run: правила question/plan_exit deny в run.ts НИКОГДА не
# вычисляются (ни один тул не ходит в permission-систему с этими именами), а
# Question.ask ждёт голый Deferred без таймаута — первый же вызов question в
# headless повис бы навсегда. Лечение — never-ask ядра, не таймаут: таймаут
# сработал бы и в TUI, где ожидание оператора — норма.
check "track-r-neverask-def"  "cli/cmd/run.ts" "export async function enableNeverAsk" \
  "включение never-ask на время headless-прогона; без него question в run висит вечно"
check "track-r-neverask-call" "cli/cmd/run.ts" "await enableNeverAsk\(sdk," \
  "ВЫЗОВ enableNeverAsk; определение без вызова = висяк остаётся при зелёном verifier"
check "track-r-neverask-restore" "cli/cmd/run.ts" "restoreRunOverrides" \
  "never-ask действует на весь инстанс — под --attach состояние обязано возвращаться как было"

# R-2. checkpoint-writer работал на модели РОДИТЕЛЯ всегда: конфиг агента
# доезжал и выбрасывался на месте спавна. Учитывается при checkpoint.fork:false
# (при fork:true кэш префикса привязан к модели родителя — смена сделала бы
# каждый чекпоинт холодным чтением).
check "track-r-writer-model-def"  "session/checkpoint-writer-model.ts" "export function resolveWriterModel" \
  "резолв модели checkpoint-writer; без него тир lite недостижим для самого дорогого системного агента"
check "track-r-writer-model-call" "session/checkpoint.ts" "resolveWriterModel\(\{" \
  "ВЫЗОВ резолва в tryStartCheckpointWriter; модуль без вызова = модель снова родительская"
check "track-r-writer-model-spawn" "session/checkpoint.ts" "providerID: writerModel\.providerID" \
  "резолвленная модель обязана доехать до actor.spawn, а не остаться локальной переменной"

# R-3. mode:"all" — законная цель actor spawn. agent.ts проставляет "all"
# каждому агенту из конфига по умолчанию, поэтому фильтр по одному "subagent"
# отбрасывал ровно объявленные пользователем роли (наблюдавшийся отказ PI-137).
check "track-r-spawnable-def"   "agent/spawnable.ts" "export function isSpawnableMode" \
  "единый предикат цели делегирования; две копии сравнения расходились молча"
check "track-r-spawnable-enum"  "tool/actor.ts" "isSpawnableMode\(a\.mode\)" \
  "enum subagent_type обязан строиться предикатом, иначе роли из конфига исчезают (PI-137)"
check "track-r-spawnable-gate"  "actor/spawn.ts" "isSpawnableMode\(agentInfo\?\.mode\)" \
  "gateEligible обязан пользоваться ТЕМ ЖЕ предикатом — иначе спавнить можно, а отчитаться нечем"
check_absent "track-r-no-subagent-literal-enum" "tool/actor.ts" 'filter\(\(a\) => a\.mode === "subagent"' \
  "возврат литерального сравнения в фильтр enum воскрешает PI-137"

# R-4 (scaffold-v0.1.33). stdin читался безусловно при не-TTY, и праздная открытая
# труба вешала прогон НАВСЕГДА ещё до создания сессии: ни вывода, ни записи в БД,
# 0 % CPU — снаружи неотличимо от зависшей модели. Правило: stdin читается только
# когда он единственный источник сообщения.
check "track-r-stdin-def"  "cli/cmd/stdin-message.ts" "export async function readMessageFromStdin" \
  "единое решение «читать ли stdin»; две копии в run.ts и thread.ts разошлись бы, а починили бы одну"
check "track-r-stdin-run"  "cli/cmd/run.ts" "readMessageFromStdin\(\{" \
  "headless run обязан ходить через предикат, иначе открытая труба снова вешает прогон навсегда"
check "track-r-stdin-tui"  "cli/cmd/tui/thread.ts" "readMessageFromStdin\(\{" \
  "у TUI тот же вход и тот же отказ; правка одного входа из двух — это и есть расхождение копий"
check_absent "track-r-no-unconditional-stdin" "cli/cmd/run.ts" 'message \+= "\\n" \+ \(await Bun\.stdin\.text\(\)\)' \
  "возврат безусловной конкатенации stdin воскрешает вечный висяк headless-прогона"

# ─── Трек R, вторая волна (scaffold-v0.1.34): дефекты, найденные критикой первой ──

# R-5. Патч never-ask закрыл ОДИН из двух тулов, зовущих question.ask напрямую. plan_exit
# в headless как вешал прогон навсегда, так и вешал — при том что документация уже
# называла дефект закрытым, а downstream ссылался на инертное правило `plan_exit: deny`.
check "track-r-planexit-neverask" "tool/plan.ts" "question\.neverAsk\(\)" \
  "plan_exit обязан уважать never-ask так же, как question, иначе headless висит вечно"

# R-6. never-ask инстанс-широкий: под --attach он гасит вопросы у ЧУЖОГО живого TUI, а
# при аварии остаётся поднятым бессрочно.
check "track-r-neverask-attach" "cli/cmd/run.ts" "if \(attached\) return async \(\) => \{\}" \
  "под --attach нельзя трогать чужой инстанс: там сидит человек, которого мы лишим вопросов"
check "track-r-restore-on-signal" "cli/cmd/run.ts" "process\.once\(sig" \
  "восстановление обязано переживать сигнал, иначе состояние инстанса остаётся изменённым навсегда"
# scaffold-v0.1.35. Предыдущая проверка доказывала, что обработчик ЕСТЬ, — и этого мало:
# `process.once(sig, …)` без явного `process.exit` ОТМЕНЯЕТ дефолтное завершение процесса.
# A/B: без обработчика → мёртв; обработчик без exit → ЖИВ; обработчик с exit → мёртв.
# То есть патч, добавивший восстановление, сделал ядро неубиваемым сигналом. Гейт, который
# смотрит только на наличие обработчика, такой регресс пропускает по построению.
check_in_block "track-r-signal-must-exit" "cli/cmd/run.ts" "process\.once\(sig" "process\.exit\(code\)" \
  "обработчик сигнала обязан завершать процесс: перехват без exit отменяет дефолтное завершение"
# scaffold-v0.1.36. Признак «bounded computation» выводился как `native && hidden`, то есть
# два несвязанных свойства делили один флаг: пометив нативного агента скрытым ради того,
# чтобы он не был целью `actor spawn`, пользователь молча лишал его чекпоинтов и
# авто-компакта. Мы поймали это на себе за сутки — на `general`.
check "track-r-bounded-list" "agent/bounded-computation.ts" "BOUNDED_COMPUTATION_AGENTS" \
  "список освобождённых от управления контекстом обязан быть явным, а не выводиться из флага видимости"
# ⚠ Правило этого файла (шапка check_absent): «проверяем НЕ только определения, но и
# реальные точки ИСПОЛЬЗОВАНИЯ — иначе verifier даёт false-pass». У новой пары точки
# использования не было, и мутация «файл на месте, импорт удалён, предикат = false»
# оставляла все проверки зелёными: механизм отключён целиком, гейт доволен.
check "track-r-bounded-call" "session/prompt.ts" "isBoundedComputationAgent[(]agent[)]" \
  "предикат обязан ВЫЗЫВАТЬСЯ в runLoop: определение без вызова — отключённый механизм"
# Множество берётся из уже существующего реестра рантайма, а не пишется руками четвёртым
# списком рядом с тремя. Рукописный список однажды уже потерял dream и distill.
check "track-r-bounded-from-registry" "agent/bounded-computation.ts" "SYSTEM_SPAWNED_AGENT_TYPES" \
  "состав обязан выводиться из SYSTEM_SPAWNED_AGENT_TYPES: рукописный список терял агентов"
# scaffold-v0.1.38. `enableNeverAsk` под `--attach` отдавала no-op с доводом «там есть кому
# спросить» — а `mimo serve` штатно поднимается БЕЗ TUI, и именно туда ходит `--attach` из
# CI. Висяк, объявленный закрытым в v0.1.32, оставался открытым в другом режиме. Защита
# сессионная: подписка на `question.asked` со сверкой `sessionID`, чужой инстанс не тронут.
check_in_block "track-r-attach-question-reject" "cli/cmd/run.ts" 'event.type === "question.asked"' "question.sessionID !== sessionID" \
  "под --attach вопрос своей сессии обязан отклоняться: инстанс-широкий флаг там трогать нельзя, а ждать некому"
# Проба stdin звала `sh -c 'read -t 0'`; `-t` — расширение bash, в `dash` (штатный /bin/sh
# Debian и Ubuntu) его нет. Замер в контейнере: труба С ДАННЫМИ давала «данных нет».
check_absent "track-r-no-shell-stdin-probe" "cli/cmd/run.ts" "read -t 0" \
  "проба stdin через внешний шелл не работает на dash: -t это расширение bash"
# ⚠ Дословная запись — плохой якорь: `printWidth: 120` в prettier форка разбивает условие
# по `&&`, а `grep -E` построчный, то есть переформатирование выключало бы негативную
# проверку молча. Ищем ОБА порядка операндов по нормализованному в одну строку тексту.
check_absent_normalized "track-r-no-native-hidden-inference" "session/prompt.ts" \
  "(native === true[^;]{0,40}hidden === true|hidden === true[^;]{0,40}native === true)" \
  "вывод bounded-computation из native+hidden отнимает чекпоинты у любого спрятанного нативного агента"

if [[ "$fail" -ne 0 ]]; then
  echo ""
  echo "::error::verify-fork-patches: КРИТИЧЕСКИЕ ПАТЧИ ОТСУТСТВУЮТ — сборка остановлена."
  echo "Источник правды — git-история форка pyramidheadshark/scaffold-kernel на теге сборки."
  echo "Снимки scripts/fork-setup/*.patched — reference-only и НЕПОЛНЫ (нет prompt.ts/goal.ts)."
  echo "Не пересоздавай форк из .patched. Чини форк-репо и перетегируй."
  exit 1
fi

if [[ "$STRICT" -eq 1 && "$check_count" -ne "$EXPECTED_CHECK_COUNT" ]]; then
  echo ""
  echo "::error::verify-fork-patches --strict: прогнано $check_count проверок, ожидалось $EXPECTED_CHECK_COUNT."
  echo "Число не совпадает — кто-то тихо убрал или добавил check()/check_absent() без обновления"
  echo "EXPECTED_CHECK_COUNT в начале скрипта. Все отдельные проверки прошли, но само их количество"
  echo "не то, что заявлено — это тот же класс регрессии, от которого защищает --strict."
  exit 1
fi

echo ""
echo "✓ verify-fork-patches: все критические Scaffold-патчи на месте (проверок: $check_count)."
