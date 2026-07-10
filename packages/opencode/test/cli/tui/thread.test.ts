import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
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
  afterEach(() => {
    mock.restore()
  })

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
    await using tmp = await tmpdir({ git: true })
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
      process.chdir(cwd)
      if (pwd === undefined) delete process.env.PWD
      else process.env.PWD = pwd
      if (tty) Object.defineProperty(process.stdin, "isTTY", tty)
      else delete (process.stdin as { isTTY?: boolean }).isTTY
      globalThis.Worker = worker
      await fs.rm(link, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  test("uses the real cwd when PWD points at a symlink", async () => {
    await check()
  })

  test("uses the real cwd after resolving a relative project from PWD", async () => {
    await check(".")
  })

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
})
