import { describe, expect, it } from "bun:test"
import { parseWriterModel, resolveWriterModel } from "../../src/session/checkpoint-writer-model"

const parent = { providerID: "openai", modelID: "gpt-5.6-sol" }
const lite = { providerID: "openai", modelID: "gpt-5.6-luna" }

describe("parseWriterModel", () => {
  it("splits on the FIRST slash so model ids may contain slashes", () => {
    expect(parseWriterModel("openrouter/anthropic/claude")).toEqual({
      providerID: "openrouter",
      modelID: "anthropic/claude",
    })
  })

  it("rejects a bare model id with no provider — spawning against no provider is worse than the parent's model", () => {
    expect(parseWriterModel("gpt-5.6-luna")).toBeUndefined()
  })

  it("rejects a leading slash (empty provider)", () => {
    expect(parseWriterModel("/gpt-5.6-luna")).toBeUndefined()
  })

  it("rejects a trailing slash (empty model id)", () => {
    expect(parseWriterModel("openai/")).toBeUndefined()
  })

  it("rejects non-strings", () => {
    expect(parseWriterModel(undefined)).toBeUndefined()
    expect(parseWriterModel(42)).toBeUndefined()
    expect(parseWriterModel({ providerID: "openai" })).toBeUndefined()
  })
})

describe("resolveWriterModel", () => {
  it("falls back to the parent's model when nothing is configured", () => {
    const out = resolveWriterModel({ agents: undefined, parentModel: parent, forkMode: false })
    expect(out.model).toEqual(parent)
    expect(out.configured).toBeUndefined()
    expect(out.ignoredBecauseFork).toBe(false)
  })

  it("uses the configured model under fork:false — the writer cold-starts anyway", () => {
    const out = resolveWriterModel({
      agents: { "checkpoint-writer": { model: "openai/gpt-5.6-luna" } },
      parentModel: parent,
      forkMode: false,
    })
    expect(out.model).toEqual(lite)
    expect(out.ignoredBecauseFork).toBe(false)
  })

  it("keeps the parent's model under fork:true and says the configured one was ignored", () => {
    // fork:true replays the parent's prefix for prompt-cache reuse, and a cache
    // is per-model. Applying a different model here would make every checkpoint
    // a cold full-prefix read.
    const out = resolveWriterModel({
      agents: { "checkpoint-writer": { model: "openai/gpt-5.6-luna" } },
      parentModel: parent,
      forkMode: true,
    })
    expect(out.model).toEqual(parent)
    expect(out.configured).toEqual(lite)
    expect(out.ignoredBecauseFork).toBe(true)
  })

  it("does not report an ignore when nothing was configured — fork:true alone must stay silent", () => {
    const out = resolveWriterModel({ agents: {}, parentModel: parent, forkMode: true })
    expect(out.ignoredBecauseFork).toBe(false)
  })

  it("falls back to the parent's model on a malformed value instead of failing the checkpoint", () => {
    const out = resolveWriterModel({
      agents: { "checkpoint-writer": { model: "gpt-5.6-luna" } },
      parentModel: parent,
      forkMode: false,
    })
    expect(out.model).toEqual(parent)
    expect(out.configured).toBeUndefined()
  })

  it("ignores other agents' models", () => {
    const out = resolveWriterModel({
      agents: { build: { model: "openai/gpt-5.6-luna" } },
      parentModel: parent,
      forkMode: false,
    })
    expect(out.model).toEqual(parent)
  })
})
