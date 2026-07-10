import { describe, expect, mock, spyOn, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../../fixture/fixture"
import * as App from "../../../src/cli/cmd/tui/app"
import { Rpc } from "../../../src/util"
import { UI } from "../../../src/cli/ui"
import * as Timeout from "../../../src/util/timeout"
import * as Network from "../../../src/cli/network"
import * as Win32 from "../../../src/cli/cmd/tui/win32"
import { TuiConfig } from "../../../src/cli/cmd/tui/config/tui"
import type { Route, SessionRoute } from "../../../src/cli/cmd/tui/context/route"
import { streamingTPS, completedTPS, formatTPS } from "../../../src/cli/cmd/tui/feature-plugins/sidebar/tps"
import type { PromptInfo } from "../../../src/cli/cmd/tui/component/prompt/history"
import { assign, strip } from "../../../src/cli/cmd/tui/component/prompt/part"
import {
  DEFAULT_THEMES,
  allThemes,
  addTheme,
  hasTheme,
  resolveTheme,
} from "../../../src/cli/cmd/tui/context/theme"

const stop = new Error("stop")
const seen = {
  tui: [] as string[],
}

function setup() {
  mock.restore()
  // Intentionally avoid mock.module() here: Bun keeps module overrides in cache
  // and mock.restore() does not reset mock.module values. If this switches back
  // to module mocks, later suites can see mocked @/config/tui and fail (e.g.
  // plugin-loader tests expecting real TuiConfig.waitForDependencies). See:
  // https://github.com/oven-sh/bun/issues/7823 and #12823.
  spyOn(App, "tui").mockImplementation(async (input) => {
    if (input.directory) seen.tui.push(input.directory)
    throw stop
  })
  spyOn(Rpc, "client").mockImplementation(() => ({
    call: async () => ({ url: "http://127.0.0.1" }) as never,
    on: () => () => {},
  }))
  spyOn(UI, "error").mockImplementation(() => {})
  spyOn(Timeout, "withTimeout").mockImplementation((input) => input)
  spyOn(Network, "resolveNetworkOptions").mockResolvedValue({
    mdns: false,
    port: 0,
    hostname: "127.0.0.1",
    mdnsDomain: "opencode.local",
    cors: [],
  })
  spyOn(Win32, "win32DisableProcessedInput").mockImplementation(() => {})
  spyOn(Win32, "win32InstallCtrlCGuard").mockReturnValue(undefined)
}

describe("tui thread", () => {
  async function call(project?: string) {
    const { TuiThreadCommand } = await import("../../../src/cli/cmd/tui/thread")
    const args: Parameters<NonNullable<typeof TuiThreadCommand.handler>>[0] = {
      _: [],
      $0: "opencode",
      project,
      prompt: "hi",
      model: undefined,
      agent: undefined,
      session: undefined,
      continue: false,
      fork: false,
      "never-ask-questions": false,
      neverAskQuestions: false,
      port: 0,
      hostname: "127.0.0.1",
      mdns: false,
      "mdns-domain": "opencode.local",
      mdnsDomain: "opencode.local",
      cors: [],
    }
    return TuiThreadCommand.handler(args)
  }

  async function check(project?: string) {
    setup()
    const tmp = await tmpdir({ git: true })
    const cwd = process.cwd()
    const pwd = process.env.PWD
    const worker = globalThis.Worker
    const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY")
    const link = path.join(path.dirname(tmp.path), path.basename(tmp.path) + "-link")
    const type = process.platform === "win32" ? "junction" : "dir"
    seen.tui.length = 0
    await fs.symlink(tmp.path, link, type)

    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    })
    globalThis.Worker = class extends EventTarget {
      onerror = null
      onmessage = null
      onmessageerror = null
      postMessage() {}
      terminate() {}
    } as unknown as typeof Worker

    try {
      process.chdir(tmp.path)
      process.env.PWD = link
      await expect(call(project)).rejects.toBe(stop)
      expect(seen.tui[0]).toBe(tmp.path)
    } finally {
      mock.restore()
      process.chdir(cwd)
      if (pwd === undefined) delete process.env.PWD
      else process.env.PWD = pwd
      if (tty) Object.defineProperty(process.stdin, "isTTY", tty)
      else delete (process.stdin as { isTTY?: boolean }).isTTY
      globalThis.Worker = worker
      await fs.rm(link, { recursive: true, force: true }).catch(() => undefined)
      await tmp[Symbol.asyncDispose]()
    }
  }

  test(
    "uses the real cwd when PWD points at a symlink",
    async () => {
      await check()
    },
    { timeout: 15000 },
  )

  test(
    "uses the real cwd after resolving a relative project from PWD",
    async () => {
      await check(".")
    },
    { timeout: 15000 },
  )

  test("prompt part strip removes persisted ids from reused file parts", () => {
    const part = {
      id: "prt_old",
      sessionID: "ses_old",
      messageID: "msg_old",
      type: "file" as const,
      mime: "image/png",
      filename: "tiny.png",
      url: "data:image/png;base64,abc",
    }

    expect(strip(part)).toEqual({
      type: "file",
      mime: "image/png",
      filename: "tiny.png",
      url: "data:image/png;base64,abc",
    })
  })

  test("prompt part assign overwrites stale runtime ids", () => {
    const part = {
      id: "prt_old",
      sessionID: "ses_old",
      messageID: "msg_old",
      type: "file" as const,
      mime: "image/png",
      filename: "tiny.png",
      url: "data:image/png;base64,abc",
    } as PromptInfo["parts"][number]

    const next = assign(part)

    expect(next.id).not.toBe("prt_old")
    expect(next.id.startsWith("prt_")).toBe(true)
    expect(next).toMatchObject({
      type: "file",
      mime: "image/png",
      filename: "tiny.png",
      url: "data:image/png;base64,abc",
    })
  })

  test("theme store addTheme writes into module store", () => {
    const name = `plugin-theme-${Date.now()}`
    expect(addTheme(name, DEFAULT_THEMES.mimocode)).toBe(true)
    expect(allThemes()[name]).toBeDefined()
  })

  test("theme store keeps first theme for duplicate names", () => {
    const name = `plugin-theme-keep-${Date.now()}`
    const one = structuredClone(DEFAULT_THEMES.mimocode)
    const two = structuredClone(DEFAULT_THEMES.mimocode)
    one.theme.primary = "#101010"
    two.theme.primary = "#fefefe"

    expect(addTheme(name, one)).toBe(true)
    expect(addTheme(name, two)).toBe(false)
    expect(allThemes()[name]).toBeDefined()
    expect(allThemes()[name]!.theme.primary).toBe("#101010")
  })

  test("theme store ignores entries without a theme object", () => {
    const name = `plugin-theme-invalid-${Date.now()}`
    expect(addTheme(name, { defs: { a: "#ffffff" } })).toBe(false)
    expect(allThemes()[name]).toBeUndefined()
  })

  test("theme store hasTheme checks theme presence", () => {
    const name = `plugin-theme-has-${Date.now()}`
    expect(hasTheme(name)).toBe(false)
    expect(addTheme(name, DEFAULT_THEMES.mimocode)).toBe(true)
    expect(hasTheme(name)).toBe(true)
  })

  test("theme store resolveTheme rejects circular color refs", () => {
    const item = structuredClone(DEFAULT_THEMES.mimocode)
    item.defs = {
      ...item.defs,
      one: "two",
      two: "one",
    }
    item.theme.primary = "one"

    expect(() => resolveTheme(item, "dark")).toThrow("Circular color reference")
  })

  test("SessionRoute type accepts agentID field", () => {
    const r: SessionRoute = {
      type: "session",
      sessionID: "ses_x",
      agentID: "actor_y",
    }
    expect(r.agentID).toBe("actor_y")
  })

  test("SessionRoute agentID is optional", () => {
    const r: SessionRoute = {
      type: "session",
      sessionID: "ses_x",
    }
    expect(r.agentID).toBeUndefined()
  })

  test("Route discriminated union still typechecks without agentID", () => {
    const r: Route = { type: "home" }
    expect(r.type).toBe("home")
  })

  test("streamingTPS returns null when combined text is empty", () => {
    expect(streamingTPS("", 1000, 5000)).toBeNull()
  })

  test("streamingTPS returns null when elapsed is below threshold", () => {
    expect(streamingTPS("a".repeat(800), 1000, 1400)).toBeNull()
  })

  test("streamingTPS returns null when elapsed is zero", () => {
    expect(streamingTPS("a".repeat(800), 1000, 1000)).toBeNull()
  })

  test("streamingTPS computes tokens per second when valid", () => {
    expect(streamingTPS("a".repeat(800), 1000, 3000)).toBe(100)
  })

  test("streamingTPS still returns positive for tiny token count above threshold", () => {
    expect(streamingTPS("abcd", 0, 1000)).toBe(1)
  })

  test("completedTPS returns null when output and reasoning are empty", () => {
    expect(completedTPS(0, 0, 1000, 5000)).toBeNull()
  })

  test("completedTPS returns null for zero-duration message", () => {
    expect(completedTPS(100, 0, 1000, 1000)).toBeNull()
  })

  test("completedTPS sums output and reasoning over elapsed seconds", () => {
    expect(completedTPS(200, 100, 1000, 4000)).toBe(100)
  })

  test("completedTPS handles reasoning-only turn", () => {
    expect(completedTPS(0, 50, 1000, 3000)).toBe(25)
  })

  test("formatTPS returns null for null input", () => {
    expect(formatTPS(null)).toBeNull()
  })

  test("formatTPS renders less-than-one values", () => {
    expect(formatTPS(0.4)).toBe("<1 t/s")
  })

  test("formatTPS rounds positive values to integer", () => {
    expect(formatTPS(42.6)).toBe("43 t/s")
    expect(formatTPS(42.4)).toBe("42 t/s")
    expect(formatTPS(1)).toBe("1 t/s")
  })
})
