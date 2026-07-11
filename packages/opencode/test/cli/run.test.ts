import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import * as Bootstrap from "../../src/cli/bootstrap"
import * as Completion from "../../src/cli/cmd/run-completion"
import * as SDK from "@mimo-ai/sdk/v2"

const originalTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY")

describe("RunCommand", () => {
  beforeEach(() => {
    mock.restore()
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    })
  })

  afterEach(() => {
    mock.restore()
    if (originalTTY) Object.defineProperty(process.stdin, "isTTY", originalTTY)
    else delete (process.stdin as { isTTY?: boolean }).isTTY
  })

  test("passes --dir to the local SDK client", async () => {
    await using tmp = await tmpdir({})

    const bootstrap = spyOn(Bootstrap, "bootstrap").mockImplementation(async (_directory, cb) => cb())
    spyOn(Completion, "createCompletionTracker").mockReturnValue({
      get done() {
        return false
      },
      completion: Promise.resolve(),
      onEvent() {},
      stop() {},
      markStarted() {},
    })

    const client = {
      event: {
        subscribe: async () => ({
          stream: {
            async *[Symbol.asyncIterator]() {},
          },
        }),
      },
      config: {
        get: async () => ({ data: { share: "manual" } }),
      },
      session: {
        list: async () => ({ data: [] }),
        create: async () => ({ data: { id: "ses_test_run" } }),
        status: async () => ({ data: {} }),
        prompt: async () => ({ data: {} }),
        command: async () => ({ data: {} }),
      },
    }

    const createClient = spyOn(SDK, "createOpencodeClient").mockReturnValue(client as never)

    const { RunCommand } = await import("../../src/cli/cmd/run")
    const args: Parameters<NonNullable<typeof RunCommand.handler>>[0] = {
      _: [],
      $0: "mimo",
      message: ["Создай файл hello.txt"],
      "--": [],
      command: undefined,
      continue: false,
      session: undefined,
      fork: false,
      share: false,
      model: undefined,
      agent: undefined,
      format: "default",
      file: undefined,
      title: undefined,
      attach: undefined,
      password: undefined,
      dir: tmp.path,
      port: undefined,
      variant: undefined,
      thinking: false,
      "dangerously-skip-permissions": false,
      dangerouslySkipPermissions: false,
    }

    await RunCommand.handler(args)

    expect(bootstrap).toHaveBeenCalledWith(tmp.path, expect.any(Function))
    expect(createClient).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "http://opencode.internal",
        directory: tmp.path,
      }),
    )
  })
})
