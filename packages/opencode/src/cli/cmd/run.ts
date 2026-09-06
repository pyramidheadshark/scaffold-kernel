import type { Argv } from "yargs"
import path from "path"
import { pathToFileURL } from "url"
import { UI } from "../ui"
import { cmd } from "./cmd"
import { Flag } from "../../flag/flag"
import { isSystemSession } from "../../session/auto-dream"
import { bootstrap } from "../bootstrap"
import { EOL } from "os"
import { Filesystem, Log } from "../../util"
import { createOpencodeClient, type OpencodeClient, type ToolPart } from "@mimo-ai/sdk/v2"
import { Server } from "../../server/server"
import { Provider } from "../../provider"
import { Agent } from "../../agent/agent"
import { Permission } from "../../permission"
import { Tool } from "../../tool"
import { GlobTool } from "../../tool/glob"
import { GrepTool } from "../../tool/grep"
import { ReadTool } from "../../tool/read"
import { WebFetchTool } from "../../tool/webfetch"
import { EditTool } from "../../tool/edit"
import { WriteTool } from "../../tool/write"
import { CodeSearchTool } from "../../tool/codesearch"
import { WebSearchTool } from "../../tool/websearch"
import { ActorTool } from "../../tool/actor"
import { SkillTool } from "../../tool/skill"
import { BashTool } from "../../tool/bash"
import { Locale } from "../../util"
import { AppRuntime } from "@/effect/app-runtime"
import { createCompletionTracker, type CompletionTracker } from "./run-completion"
import { readMessageFromStdin } from "./stdin-message"

type ToolProps<T> = {
  input: Tool.InferParameters<T>
  metadata: Tool.InferMetadata<T>
  part: ToolPart
}

async function enableDangerousDeleteApproval(
  sdk: Pick<OpencodeClient, "permission">,
  enabled: boolean,
  attached: boolean,
) {
  if (!enabled) return async () => {}
  // Тот же довод, что у never-ask, и здесь он весомее: автоодобрение УДАЛЕНИЙ тоже
  // инстанс-широкое, а `--attach` по определению чужой сервер, на котором может сидеть
  // человек. Довод применили к менее опасному переключателю и не применили к более
  // опасному — исправляется здесь.
  if (attached) return async () => {}
  const previous = (await sdk.permission.autoApproveDelete(undefined, { throwOnError: true })).data === true
  if (previous) return async () => {}

  await sdk.permission.setAutoApproveDelete({ enabled: true }, { throwOnError: true })
  const state = { restored: false }
  return async () => {
    // Флаг ДО await, а не после: иначе два конкурентных вызова оба проходят проверку и
    // оба шлют disable. Та же форма, что у restore never-ask.
    if (state.restored) return
    state.restored = true
    // ⚠ `.catch`, а не `throwOnError` без ловли. Эти два восстановления зовутся подряд из
    // одного `finally`, и delete-restore идёт ПЕРВЫМ: его исключение вылетало из `finally`
    // и (а) валило успешный прогон, (б) съедало восстановление never-ask, которое стоит
    // следом. У never-ask ловля есть, у этого не было — асимметрия, которую видно только
    // при чтении обоих мест сразу.
    await sdk.permission.setAutoApproveDelete({ enabled: false }, { throwOnError: true }).catch(() => {})
  }
}

/**
 * Turn on never-ask for the duration of a headless run, and restore it after.
 *
 * Scaffold, 2026-09-06. `run` creates its session with `question: deny` and
 * `plan_exit: deny` rules (below) — and neither rule is ever evaluated.
 * QuestionTool (tool/question.ts) and PlanExitTool (tool/plan.ts) both call
 * `question.ask(...)` directly; neither goes through `ctx.ask({ permission })`,
 * and a grep for `permission: "question"` finds only the two producers (here and
 * github.ts) and no consumer at all. Meanwhile `Question.ask` waits on a bare
 * `Deferred.await` with no timeout, and `run` subscribes to `permission.asked`
 * but never to `question.asked`. So the first question tool call in a headless
 * run waits forever: no prompt, no output, no exit. It has not happened yet —
 * a latent trap, not an observed outage.
 *
 * never-ask is the kernel's own answer to exactly this: the tool stays visible
 * (so the model keeps routing decisions through it) but returns a [Never-Ask]
 * directive telling the model to pick the option that suits unattended
 * execution and to say which one it picked. Deliberately NOT a timeout — a
 * timeout would also fire in the TUI, where waiting is correct: an operator
 * stepping away for an hour is not a defect.
 *
 * Save-and-restore, in the same shape as enableDangerousDeleteApproval, because
 * never-ask is instance-wide: under `--attach` this run shares a server with
 * whoever else is on it, so it must hand the state back exactly as found.
 */
/**
 * Есть ли что-то читаемое на stdin ПРЯМО СЕЙЧАС.
 *
 * Нужно только чтобы не врать в сообщении. Прежняя редакция печатала «stdin не прочитан»
 * при ЛЮБОМ не-TTY stdin — то есть в CI, под `< /dev/null`, под nohup, на каждом
 * headless-прогоне, где никаких данных не было и терять было нечего. Совет «уберите
 * аргумент» там приводил бы к отказу «You must provide a message».
 *
 * Проба неблокирующая и однократная: держать её дольше значило бы воспроизвести тот самый
 * висяк, от которого правило и защищает.
 */
async function stdinHasData(): Promise<boolean> {
  try {
    const fs = await import("node:fs")
    const st = fs.fstatSync(0)
    // Файл или устройство с ненулевым размером — данные точно есть.
    if (st.isFile() && st.size > 0) return true
    if (!st.isFIFO() && !st.isSocket()) return false
    // Труба: спрашиваем ОС, не читая. Пустая незакрытая труба даёт 0.
    // ⚠ Здесь стоял `sh -c 'read -t 0'`, и он не работал НИ НА ОДНОЙ из двух сторон.
    //
    // `-t` — расширение bash/ksh/zsh. На Debian и Ubuntu `/bin/sh` это `dash`, где такого
    // ключа нет: `read: Illegal option -t` → ветка `|| echo no` → проба говорит «данных
    // нет» даже на трубе С ДАННЫМИ. То есть на самом распространённом образе уведомление
    // не печаталось никогда. А там, где `/bin/sh` это bash, `read -t 0` на ПУСТОЙ ЗАКРЫТОЙ
    // трубе возвращает успех (EOF читается как готовность) — и проба кричала ложно.
    //
    // Оба исхода противоположны заявленному, и оба нашлись замером в контейнере, а не
    // чтением. Внешний шелл убран: спрашиваем ядро напрямую неблокирующим чтением.
    const fd = fs.openSync("/dev/stdin", fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
    try {
      const buf = Buffer.alloc(1)
      // EAGAIN — труба открыта и пуста: данных сейчас нет. 0 — EOF, писателя нет.
      // Больше нуля — данные есть, и мы их НЕ потребляем: читаем с позиции 0 файла,
      // а для трубы pread недоступен, поэтому берём только сам факт готовности.
      const n = fs.readSync(fd, buf, 0, 1, null)
      return n > 0
    } finally {
      fs.closeSync(fd)
    }
  } catch (err) {
    // EAGAIN/EWOULDBLOCK — «пусто прямо сейчас», это ответ, а не неудача пробы.
    if ((err as NodeJS.ErrnoException)?.code === "EAGAIN") return false
    return false // не смогли выяснить — молчим, а не кричим ложно
  }
}

export async function enableNeverAsk(sdk: Pick<OpencodeClient, "question">, attached: boolean) {
  // Под `--attach` не трогаем НИЧЕГО.
  //
  // never-ask инстанс-широкий, а `--attach` по определению означает чужой сервер, на
  // котором может сидеть живой TUI. Первая редакция включала его и там, полагая, что
  // восстановление в конце всё чинит: не чинит. Пока идёт прогон, у человека question-тул
  // перестаёт спрашивать и «решает сам»; два параллельных прогона гасят защиту друг другу
  // (второй видит true, возвращает no-op restore, первый в конце выключает — второй
  // доигрывает без защиты); а падение процесса между включением и `finally` оставляет
  // флаг поднятым бессрочно.
  //
  // Своя, локально поднятая петля таких соседей не имеет — там включать безопасно.
  //
  // ⚠ Но «под --attach есть кому спросить» — НЕ определение режима, и первая редакция
  // этого комментария была неправа. `mimo serve` штатно поднимается без TUI, и именно
  // туда ходит `--attach` из CI: спросить там некого, а `Question.ask` ждёт голый
  // `Deferred.await` без предельного времени. То есть висяк, объявленный закрытым в
  // v0.1.32, оставался открытым в другом режиме — закрыли в одном месте и внесли в
  // другое, назвав это определением.
  //
  // Здесь мы по-прежнему НЕ трогаем инстанс-широкий флаг (сосед не должен пострадать), а
  // защиту даёт сессионная подписка в петле событий ниже: `question.asked` с чужим
  // `sessionID` пропускается, свой — отклоняется. Тот же приём, что уже применён к
  // `permission.asked` в этом файле.
  if (attached) return async () => {}

  const previous = await sdk.question
    .neverAsk(undefined, { throwOnError: true })
    .then((r) => r.data === true)
    .catch(() => undefined)
  // Unknown previous state ⇒ do not touch it. Turning never-ask on without
  // being able to turn it back off is worse than the latent hang it prevents.
  if (previous === undefined || previous) return async () => {}

  const enabled = await sdk.question
    .setNeverAsk({ enabled: true }, { throwOnError: true })
    .then(() => true)
    .catch(() => false)
  if (!enabled) return async () => {}

  const state = { restored: false }
  return async () => {
    if (state.restored) return
    state.restored = true
    await sdk.question.setNeverAsk({ enabled: false }).catch(() => {})
  }
}

function props<T>(part: ToolPart): ToolProps<T> {
  const state = part.state
  return {
    input: state.input as Tool.InferParameters<T>,
    metadata: ("metadata" in state ? state.metadata : {}) as Tool.InferMetadata<T>,
    part,
  }
}

type Inline = {
  icon: string
  title: string
  description?: string
}

function inline(info: Inline) {
  const suffix = info.description ? UI.Style.TEXT_DIM + ` ${info.description}` + UI.Style.TEXT_NORMAL : ""
  UI.println(UI.Style.TEXT_NORMAL + info.icon, UI.Style.TEXT_NORMAL + info.title + suffix)
}

function block(info: Inline, output?: string) {
  UI.empty()
  inline(info)
  if (!output?.trim()) return
  UI.println(output)
  UI.empty()
}

function fallback(part: ToolPart) {
  const state = part.state
  const input = "input" in state ? state.input : undefined
  const title =
    ("title" in state && state.title ? state.title : undefined) ||
    (input && typeof input === "object" && Object.keys(input).length > 0 ? JSON.stringify(input) : "Unknown")
  inline({
    icon: "⚙",
    title: `${part.tool} ${title}`,
  })
}

function glob(info: ToolProps<typeof GlobTool>) {
  const root = info.input.path ?? ""
  const title = `Glob "${info.input.pattern}"`
  const suffix = root ? `in ${normalizePath(root)}` : ""
  const num = info.metadata.count
  const description =
    num === undefined ? suffix : `${suffix}${suffix ? " · " : ""}${num} ${num === 1 ? "match" : "matches"}`
  inline({
    icon: "✱",
    title,
    ...(description && { description }),
  })
}

function grep(info: ToolProps<typeof GrepTool>) {
  const root = info.input.path ?? ""
  const title = `Grep "${info.input.pattern}"`
  const suffix = root ? `in ${normalizePath(root)}` : ""
  const num = info.metadata.matches
  const description =
    num === undefined ? suffix : `${suffix}${suffix ? " · " : ""}${num} ${num === 1 ? "match" : "matches"}`
  inline({
    icon: "✱",
    title,
    ...(description && { description }),
  })
}

function read(info: ToolProps<typeof ReadTool>) {
  const file = normalizePath(info.input.file_path)
  const pairs = Object.entries(info.input).filter(([key, value]) => {
    if (key === "file_path") return false
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
  })
  const description = pairs.length ? `[${pairs.map(([key, value]) => `${key}=${value}`).join(", ")}]` : undefined
  inline({
    icon: "→",
    title: `Read ${file}`,
    ...(description && { description }),
  })
}

function write(info: ToolProps<typeof WriteTool>) {
  block(
    {
      icon: "←",
      title: `Write ${normalizePath(info.input.file_path)}`,
    },
    info.part.state.status === "completed" ? info.part.state.output : undefined,
  )
}

function webfetch(info: ToolProps<typeof WebFetchTool>) {
  inline({
    icon: "%",
    title: `WebFetch ${info.input.url}`,
  })
}

function edit(info: ToolProps<typeof EditTool>) {
  const title = normalizePath(info.input.file_path)
  const diff = info.metadata.diff
  block(
    {
      icon: "←",
      title: `Edit ${title}`,
    },
    diff,
  )
}

function codesearch(info: ToolProps<typeof CodeSearchTool>) {
  inline({
    icon: "◇",
    title: `Exa Code Search "${info.input.query}"`,
  })
}

function websearch(info: ToolProps<typeof WebSearchTool>) {
  inline({
    icon: "◈",
    title: `Web Search "${info.input.query}"`,
  })
}

function task(info: ToolProps<typeof ActorTool>) {
  const op = (info.part.state.input as any)?.operation ?? info.part.state.input
  const status = info.part.state.status
  const subagent =
    typeof op?.subagent_type === "string" && op.subagent_type.trim().length > 0 ? op.subagent_type : "unknown"
  const agent = Locale.titlecase(subagent)
  const desc = typeof op?.description === "string" && op.description.trim().length > 0 ? op.description : undefined
  const icon = status === "error" ? "✗" : status === "running" ? "•" : "✓"
  const name = desc ?? `${agent} Task`
  inline({
    icon,
    title: name,
    description: desc ? `${agent} Agent` : undefined,
  })
}

function skill(info: ToolProps<typeof SkillTool>) {
  inline({
    icon: "→",
    title: `Skill "${info.input.name}"`,
  })
}

function bash(info: ToolProps<typeof BashTool>) {
  const output = info.part.state.status === "completed" ? info.part.state.output?.trim() : undefined
  block(
    {
      icon: "$",
      title: `${info.input.command}`,
    },
    output,
  )
}

function normalizePath(input?: string) {
  if (!input) return ""
  if (path.isAbsolute(input)) return path.relative(process.cwd(), input) || "."
  return input
}

export const RunCommand = cmd({
  command: "run [message..]",
  describe: "run mimocode with a message",
  builder: (yargs: Argv) => {
    return yargs
      .positional("message", {
        describe: "message to send",
        type: "string",
        array: true,
        default: [],
      })
      .option("command", {
        describe: "the command to run, use message for args",
        type: "string",
      })
      .option("continue", {
        alias: ["c"],
        describe: "continue the last session",
        type: "boolean",
      })
      .option("session", {
        alias: ["s"],
        describe: "session id to continue",
        type: "string",
      })
      .option("fork", {
        describe: "fork the session before continuing (requires --continue or --session)",
        type: "boolean",
      })
      .option("share", {
        type: "boolean",
        describe: "share the session",
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: "model to use in the format of provider/model",
      })
      .option("agent", {
        type: "string",
        describe: "agent to use",
      })
      .option("format", {
        type: "string",
        choices: ["default", "json"],
        default: "default",
        describe: "format: default (formatted) or json (raw JSON events)",
      })
      .option("file", {
        alias: ["f"],
        type: "string",
        array: true,
        describe: "file(s) to attach to message",
      })
      .option("title", {
        type: "string",
        describe: "title for the session (uses truncated prompt if no value provided)",
      })
      .option("attach", {
        type: "string",
        describe: "attach to a running mimocode server (e.g., http://localhost:4096)",
      })
      .option("password", {
        alias: ["p"],
        type: "string",
        describe: "basic auth password (defaults to MIMOCODE_SERVER_PASSWORD)",
      })
      .option("dir", {
        type: "string",
        describe: "directory to run in, path on remote server if attaching",
      })
      .option("port", {
        type: "number",
        describe: "port for the local server (defaults to random port if no value provided)",
      })
      .option("variant", {
        type: "string",
        describe: "model variant (provider-specific reasoning effort, e.g., high, max, minimal)",
      })
      .option("thinking", {
        type: "boolean",
        describe: "show thinking blocks",
        default: false,
      })
      .option("role", {
        type: "string",
        choices: ["user", "assistant"],
        describe: "role for the injected message (assistant injects text as model output then triggers continuation)",
      })
      .option("dangerously-skip-permissions", {
        alias: ["yolo"],
        type: "boolean",
        describe: "auto-approve permissions that are not explicitly denied (dangerous!)",
        default: false,
      })
  },
  handler: async (args) => {
    let message = [...args.message, ...(args["--"] || [])]
      .map((arg) => (arg.includes(" ") ? `"${arg.replace(/"/g, '\\"')}"` : arg))
      .join(" ")

    const directory = await (async () => {
      if (!args.dir) return undefined
      if (args.attach) return args.dir
      try {
        process.chdir(args.dir)
        return process.cwd()
      } catch {
        UI.error("Failed to change directory to " + args.dir)
        await Log.exit(1)
        throw new Error("Log.exit returned unexpectedly")
      }
    })()

    const files: { type: "file"; url: string; filename: string; mime: string }[] = []
    if (args.file) {
      const list = Array.isArray(args.file) ? args.file : [args.file]

      for (const filePath of list) {
        const resolvedPath = path.resolve(process.cwd(), filePath)
        if (!(await Filesystem.exists(resolvedPath))) {
          UI.error(`File not found: ${filePath}`)
          await Log.exit(1)
        }

        const mime = (await Filesystem.isDir(resolvedPath)) ? "application/x-directory" : "text/plain"

        files.push({
          type: "file",
          url: pathToFileURL(resolvedPath).href,
          filename: path.basename(resolvedPath),
          mime,
        })
      }
    }

    // stdin is read ONLY when it is the sole source of the message — see
    // stdin-message.ts. Previously this was unconditional for a non-TTY stdin, and
    // an idle open pipe (agent harness, cron wrapper) blocked the run forever
    // before a session existed: no output, no database row, no CPU.
    const piped = await readMessageFromStdin({
      argument: message,
      // `--command` — тоже источник задания: при `run --command plan` без позиционного
      // сообщения `message` пуст, и правило «stdin единственный источник» ошибочно
      // разрешало читать его до EOF. Праздная труба вешала прогон ровно так же.
      hasCommand: Boolean(args.command),
      isTTY: Boolean(process.stdin.isTTY),
      read: () => Bun.stdin.text(),
    })
    if (piped !== undefined) message = piped
    // ⚠ Условие `message.trim().length > 0` пропускало случай `run --command X` с трубой:
    // позиционного сообщения там нет, `message` пуст, и вход терялся МОЛЧА — при том что
    // именно ради «молчаливая потеря хуже заметного висяка» это уведомление и заведено.
    else if (!process.stdin.isTTY && (message.trim().length > 0 || Boolean(args.command)) && (await stdinHasData())) {
      // Собственный критерий этого же решения — «молчаливая потеря хуже заметного
      // висяка» — обязывает сказать вслух. Правило (stdin читается только когда он
      // единственный источник сообщения) отбрасывает вход, если сообщение уже передано
      // аргументом; молча это тот же дефект, от которого правило и защищает.
      UI.println(
        UI.Style.TEXT_DIM +
          "stdin содержит данные, но не прочитан: задание передано аргументом или --command." +
          UI.Style.TEXT_NORMAL,
      )
    }

    if (message.trim().length === 0 && !args.command) {
      UI.error("You must provide a message or a command")
      await Log.exit(1)
    }

    if (args.fork && !args.continue && !args.session) {
      UI.error("--fork requires --continue or --session")
      await Log.exit(1)
    }

    // These two rules are INERT — see enableNeverAsk above for why (no tool ever
    // routes `question` or `plan_exit` through the permission system). Kept so the
    // ruleset shape stays identical to sessions created by older builds; the actual
    // headless protection is enableNeverAsk.
    const rules: Permission.Ruleset = [
      {
        permission: "question",
        action: "deny",
        pattern: "*",
      },
      {
        permission: "plan_exit",
        action: "deny",
        pattern: "*",
      },
    ]

    function title() {
      if (args.title === undefined) return
      if (args.title !== "") return args.title
      return message.slice(0, 50) + (message.length > 50 ? "..." : "")
    }

    async function session(sdk: OpencodeClient) {
      const baseID = args.continue
        ? (await sdk.session.list()).data?.find((s) => !s.parentID && !isSystemSession(s))?.id
        : args.session

      if (baseID && args.fork) {
        const forked = await sdk.session.fork({ sessionID: baseID })
        return forked.data?.id
      }

      if (baseID) return baseID

      const name = title()
      const result = await sdk.session.create({ title: name, permission: rules })
      return result.data?.id
    }

    async function share(sdk: OpencodeClient, sessionID: string) {
      const cfg = await sdk.config.get()
      if (!cfg.data) return
      if (cfg.data.share !== "auto" && !Flag.MIMOCODE_AUTO_SHARE && !args.share) return
      const res = await sdk.session.share({ sessionID }).catch((error) => {
        if (error instanceof Error && error.message.includes("disabled")) {
          UI.println(UI.Style.TEXT_DANGER_BOLD + "!  " + error.message)
        }
        return { error }
      })
      if (!res.error && "data" in res && res.data?.share?.url) {
        UI.println(UI.Style.TEXT_INFO_BOLD + "~  " + res.data.share.url)
      }
    }

    async function execute(sdk: OpencodeClient) {
      function tool(part: ToolPart) {
        try {
          if (part.tool === "bash") return bash(props<typeof BashTool>(part))
          if (part.tool === "glob") return glob(props<typeof GlobTool>(part))
          if (part.tool === "grep") return grep(props<typeof GrepTool>(part))
          if (part.tool === "read") return read(props<typeof ReadTool>(part))
          if (part.tool === "write") return write(props<typeof WriteTool>(part))
          if (part.tool === "webfetch") return webfetch(props<typeof WebFetchTool>(part))
          if (part.tool === "edit") return edit(props<typeof EditTool>(part))
          if (part.tool === "codesearch") return codesearch(props<typeof CodeSearchTool>(part))
          if (part.tool === "websearch") return websearch(props<typeof WebSearchTool>(part))
          if (part.tool === "actor") return task(props<typeof ActorTool>(part))
          if (part.tool === "skill") return skill(props<typeof SkillTool>(part))
          return fallback(part)
        } catch {
          return fallback(part)
        }
      }

      function emit(type: string, data: Record<string, unknown>) {
        if (args.format === "json") {
          process.stdout.write(JSON.stringify({ type, timestamp: Date.now(), sessionID, ...data }) + EOL)
          return true
        }
        return false
      }

      const events = await sdk.event.subscribe()
      let error: string | undefined

      async function loop(tracker: CompletionTracker, restoreRunOverrides: () => Promise<void>) {
        const toggles = new Map<string, boolean>()
        const log = Log.create({ service: "cli.run" })

        const iter = events.stream[Symbol.asyncIterator]()
        const doneSignal = tracker.completion.then(() => "DONE" as const)

        try {
          while (true) {
            const next = await Promise.race([iter.next(), doneSignal])
            if (next === "DONE") break
            if (next.done) break
            const event = next.value
            tracker.onEvent(event)

            log.debug("event received", {
              type: event.type,
            })
            if (
              event.type === "message.updated" &&
              event.properties.info.role === "assistant" &&
              args.format !== "json" &&
              toggles.get("start") !== true
            ) {
              UI.empty()
              UI.println(`> ${event.properties.info.agent} · ${event.properties.info.modelID}`)
              UI.empty()
              toggles.set("start", true)
            }

            if (event.type === "message.part.updated") {
              const part = event.properties.part
              if (part.sessionID !== sessionID) continue

              if (part.type === "tool" && (part.state.status === "completed" || part.state.status === "error")) {
                if (emit("tool_use", { part })) continue
                if (part.state.status === "completed") {
                  tool(part)
                  continue
                }
                inline({
                  icon: "✗",
                  title: `${part.tool} failed`,
                })
                UI.error(part.state.error)
              }

              if (
                part.type === "tool" &&
                part.tool === "actor" &&
                part.state.status === "running" &&
                args.format !== "json"
              ) {
                if (toggles.get(part.id) === true) continue
                task(props<typeof ActorTool>(part))
                toggles.set(part.id, true)
              }

              if (part.type === "step-start") {
                if (emit("step_start", { part })) continue
              }

              if (part.type === "step-finish") {
                if (emit("step_finish", { part })) continue
              }

              if (part.type === "text" && part.time?.end) {
                if (emit("text", { part })) continue
                const text = part.text.trim()
                if (!text) continue
                if (!process.stdout.isTTY) {
                  process.stdout.write(text + EOL)
                  continue
                }
                UI.empty()
                UI.println(text)
                UI.empty()
              }

              if (part.type === "reasoning" && part.time?.end && args.thinking) {
                if (emit("reasoning", { part })) continue
                const text = part.text.trim()
                if (!text) continue
                const line = `Thinking: ${text}`
                if (process.stdout.isTTY) {
                  UI.empty()
                  UI.println(`${UI.Style.TEXT_DIM}\u001b[3m${line}\u001b[0m${UI.Style.TEXT_NORMAL}`)
                  UI.empty()
                  continue
                }
                process.stdout.write(line + EOL)
              }
            }

            if (event.type === "session.error") {
              const props = event.properties
              if (props.sessionID !== sessionID || !props.error) continue
              let err = String(props.error.name)
              if ("data" in props.error && props.error.data && "message" in props.error.data) {
                err = String(props.error.data.message)
              }
              error = error ? error + EOL + err : err
              if (emit("error", { error: props.error })) continue
              UI.error(err)
            }

            // Вопрос модели в headless-прогоне некому ответить. Под своей петлёй это
            // закрывает инстанс-широкий never-ask (`enableNeverAsk`), но под `--attach`
            // трогать чужой инстанс нельзя — там защита сессионная и живёт здесь.
            //
            // Отклонение, а не молчание: `Question.ask` ждёт без предельного времени, и
            // прогон вис бы навсегда. Модель получает определённый исход («вопрос
            // отклонён») и продолжает, а не стоит до убийства снаружи.
            if (event.type === "question.asked") {
              const question = event.properties
              if (question.sessionID !== sessionID) continue
              UI.println(
                UI.Style.TEXT_WARNING_BOLD + "!",
                UI.Style.TEXT_NORMAL +
                  `question asked in a headless run (${question.questions.length}); auto-rejecting — ` +
                  "there is nobody to answer under --attach",
              )
              await sdk.question.reject({ requestID: question.id }).catch(() => {})
              continue
            }

            if (event.type === "permission.asked") {
              const permission = event.properties
              if (permission.sessionID !== sessionID) continue

              if (args["dangerously-skip-permissions"]) {
                await sdk.permission.reply({
                  requestID: permission.id,
                  reply: "once",
                })
              } else {
                UI.println(
                  UI.Style.TEXT_WARNING_BOLD + "!",
                  UI.Style.TEXT_NORMAL +
                    `permission requested: ${permission.permission} (${permission.patterns.join(", ")}); auto-rejecting`,
                )
                await sdk.permission.reply({
                  requestID: permission.id,
                  reply: "reject",
                })
              }
            }
          }
        } finally {
          tracker.stop()
          await iter.return?.(undefined).catch(() => {})
          await restoreRunOverrides()
        }
      }

      // Validate agent if specified
      const agent = await (async () => {
        if (!args.agent) return undefined
        const name = args.agent

        // When attaching, validate against the running server instead of local Instance state.
        if (args.attach) {
          const modes = await sdk.app
            .agents(undefined, { throwOnError: true })
            .then((x) => x.data ?? [])
            .catch(() => undefined)

          if (!modes) {
            UI.println(
              UI.Style.TEXT_WARNING_BOLD + "!",
              UI.Style.TEXT_NORMAL,
              `failed to list agents from ${args.attach}. Falling back to default agent`,
            )
            return undefined
          }

          const agent = modes.find((a) => a.name === name)
          if (!agent) {
            UI.println(
              UI.Style.TEXT_WARNING_BOLD + "!",
              UI.Style.TEXT_NORMAL,
              `agent "${name}" not found. Falling back to default agent`,
            )
            return undefined
          }

          if (agent.mode === "subagent") {
            UI.println(
              UI.Style.TEXT_WARNING_BOLD + "!",
              UI.Style.TEXT_NORMAL,
              `agent "${name}" is a subagent, not a primary agent. Falling back to default agent`,
            )
            return undefined
          }

          return name
        }

        const entry = await AppRuntime.runPromise(Agent.Service.use((svc) => svc.get(name)))
        if (!entry) {
          UI.println(
            UI.Style.TEXT_WARNING_BOLD + "!",
            UI.Style.TEXT_NORMAL,
            `agent "${name}" not found. Falling back to default agent`,
          )
          return undefined
        }
        if (entry.mode === "subagent") {
          UI.println(
            UI.Style.TEXT_WARNING_BOLD + "!",
            UI.Style.TEXT_NORMAL,
            `agent "${name}" is a subagent, not a primary agent. Falling back to default agent`,
          )
          return undefined
        }
        return name
      })()

      const sessionID = await session(sdk)
      if (!sessionID) {
        UI.error("Session not found")
        await Log.exit(1)
        throw new Error("Log.exit returned unexpectedly")
      }
      await share(sdk, sessionID)

      const queryLog = Log.create({ service: "cli.run.poll" })
      const tracker = createCompletionTracker({
        sessionID,
        query: async () => {
          try {
            const out = await sdk.session.status()
            return out.data?.[sessionID]
          } catch (error) {
            queryLog.debug("session.status query failed", { error })
            throw error
          }
        },
      })

      const restoreDeleteApproval = await enableDangerousDeleteApproval(
        sdk,
        args["dangerously-skip-permissions"],
        Boolean(args.attach),
      )
      const restoreNeverAsk = await enableNeverAsk(sdk, Boolean(args.attach))
      const restoreRunOverrides = async () => {
        await restoreDeleteApproval()
        await restoreNeverAsk()
      }

      // Сигналы: восстановить состояние инстанса И ЗАВЕРШИТЬСЯ.
      //
      // ⚠ Первая редакция ставила обработчик без выхода — и тем ОТМЕНЯЛА дефолтное
      // завершение процесса. Замер (bun 1.4.0, тот же рантайм; базлайн — живой бинарь
      // 0.1.31): без обработчика SIGTERM и SIGHUP убивают процесс, с этим паттерном
      // обе оставляют его ALIVE. То есть патч, чинивший потерю состояния, породил
      // ядро, которое переусыновляется на systemd вместо смерти, а после SIGHUP живёт
      // уже БЕЗ never-ask — и первый же `question` вешает его навсегда. Два патча
      // одного релиза складывались в тот самый вечный висяк, который релиз закрывал.
      //
      // Дедлайн на restore обязателен: без него зависший HTTP-вызов к серверу держал бы
      // процесс, который обязан умирать. Лучше выйти с невосстановленным флагом, чем не
      // выйти вовсе — флаг чинится следующим прогоном, невыход не чинится ничем.
      const RESTORE_DEADLINE_MS = 2_000
      for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
        process.once(sig, () => {
          const code = sig === "SIGINT" ? 130 : sig === "SIGHUP" ? 129 : 143
          void Promise.race([
            restoreRunOverrides(),
            new Promise(resolve => setTimeout(resolve, RESTORE_DEADLINE_MS)),
          ]).finally(() => process.exit(code))
        })
      }

      loop(tracker, restoreRunOverrides).catch(async (e) => {
        console.error(e)
        await Log.exit(1)
      })

      try {
        if (args.command) {
          await sdk.session.command({
            sessionID,
            agent,
            model: args.model,
            command: args.command,
            arguments: message,
            variant: args.variant,
          })
        } else {
          const model = args.model ? Provider.parseModel(args.model) : undefined
          const params = {
            sessionID,
            agent,
            model,
            variant: args.variant,
            role: args.role as "user" | "assistant" | undefined,
            parts: [...files, { type: "text" as const, text: message }],
          }
          await sdk.session.prompt(params as typeof params & Record<string, unknown>)
        }
        tracker.markStarted()
      } catch (error) {
        await restoreRunOverrides()
        throw error
      }
    }

    if (args.attach) {
      const headers = (() => {
        const password = args.password ?? process.env.MIMOCODE_SERVER_PASSWORD
        if (!password) return undefined
        const username = process.env.MIMOCODE_SERVER_USERNAME ?? "mimocode"
        const auth = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
        return { Authorization: auth }
      })()
      const sdk = createOpencodeClient({ baseUrl: args.attach, directory, headers })
      return await execute(sdk)
    }

    await bootstrap(process.cwd(), async () => {
      const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        return Server.Default().app.fetch(request)
      }) as typeof globalThis.fetch
      const sdk = createOpencodeClient({ baseUrl: "http://opencode.internal", fetch: fetchFn })
      await execute(sdk)
    })
  },
})
