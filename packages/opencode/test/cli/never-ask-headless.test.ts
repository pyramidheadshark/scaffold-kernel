import { describe, expect, it } from "bun:test"
import { enableNeverAsk } from "../../src/cli/cmd/run"

// A headless `run` has nobody to answer a question, and Question.ask waits on a
// bare Deferred with no timeout — so the first question tool call would hang the
// run forever. enableNeverAsk turns the kernel's own never-ask directive on for
// the duration of the run. never-ask is INSTANCE-wide, and `run --attach` shares
// an instance with whoever else is on that server, so the contract under test is
// as much "hands the state back" as "turns it on".

type Call = { op: "get" | "set"; enabled?: boolean }

function fakeSdk(opts: { initial?: boolean; getThrows?: boolean; setThrows?: boolean }) {
  const calls: Call[] = []
  let state = opts.initial ?? false
  const sdk = {
    question: {
      neverAsk: async () => {
        calls.push({ op: "get" })
        if (opts.getThrows) throw new Error("no such endpoint")
        return { data: state }
      },
      setNeverAsk: async ({ enabled }: { enabled: boolean }) => {
        calls.push({ op: "set", enabled })
        if (opts.setThrows) throw new Error("refused")
        state = enabled
        return { data: state }
      },
    },
  }
  return { sdk: sdk as never, calls, read: () => state }
}

describe("enableNeverAsk", () => {
  it("под --attach не трогает инстанс ВООБЩЕ — там чужой сервер и, возможно, живой TUI", async () => {
    // never-ask инстанс-широкий. Восстановление в конце ущерб не отменяет: пока идёт
    // прогон, у человека question-тул перестаёт спрашивать. Плюс два параллельных
    // прогона гасят защиту друг другу, а падение оставляет флаг поднятым бессрочно.
    const f = fakeSdk({ initial: false })
    const restore = await enableNeverAsk(f.sdk, true)
    await restore()
    expect(f.calls).toEqual([])
    expect(f.read()).toBe(false)
  })

  it("turns never-ask on, and the returned restore turns it back off", async () => {
    const f = fakeSdk({ initial: false })
    const restore = await enableNeverAsk(f.sdk, false)
    expect(f.read()).toBe(true)
    await restore()
    expect(f.read()).toBe(false)
  })

  it("leaves an already-on instance alone — restoring would turn OFF what someone else turned on", async () => {
    const f = fakeSdk({ initial: true })
    const restore = await enableNeverAsk(f.sdk, false)
    await restore()
    expect(f.read()).toBe(true)
    expect(f.calls.some((c) => c.op === "set")).toBe(false)
  })

  it("does not touch the instance when the previous state cannot be read", async () => {
    // Turning never-ask on without being able to put it back is worse than the
    // latent hang it prevents: an attached TUI would silently stop asking.
    const f = fakeSdk({ getThrows: true })
    const restore = await enableNeverAsk(f.sdk, false)
    await restore()
    expect(f.calls.filter((c) => c.op === "set")).toEqual([])
  })

  it("does not promise a restore it cannot perform when enabling fails", async () => {
    const f = fakeSdk({ initial: false, setThrows: true })
    const restore = await enableNeverAsk(f.sdk, false)
    await restore()
    expect(f.calls.filter((c) => c.op === "set").length).toBe(1)
  })

  it("is idempotent: calling restore twice issues one disable", async () => {
    const f = fakeSdk({ initial: false })
    const restore = await enableNeverAsk(f.sdk, false)
    await restore()
    await restore()
    expect(f.calls.filter((c) => c.op === "set" && c.enabled === false).length).toBe(1)
  })
})
