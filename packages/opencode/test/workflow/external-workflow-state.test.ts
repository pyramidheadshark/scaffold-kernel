import { describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import {
  loadExternalWorkflowSnapshot,
  parseExternalWorkflowSnapshot,
} from "../../src/workflow/external-workflow-state"
import { mergeExternalWorkflowStatus, resolveWorkflowStateFile } from "../../src/workflow/runtime"

describe("external workflow snapshot contract", () => {
  test("parses a valid generic workflow snapshot", () => {
    const result = parseExternalWorkflowSnapshot({
      version: 1,
      source: "external-provider",
      taskId: "task-1",
      taskName: "Example task",
      currentPhase: "P4",
      topLevelStep: "Зафиксированные тесты",
      blocking: true,
      blockingGates: ["G5"],
      nextAction: {
        title: "Закрыть G5",
        reason: "Implementation blocked",
      },
      readinessVerdict: "blocked",
    })
    expect(result).toBeDefined()
    expect(result?.taskId).toBe("task-1")
    expect(result?.blocking).toBe(true)
    expect(result?.nextAction?.title).toBe("Закрыть G5")
  })

  test("does not require S2TDD-specific fields", () => {
    const result = parseExternalWorkflowSnapshot({
      version: 1,
      source: "external-provider",
      currentPhase: "research",
      topLevelStep: "Research",
      blocking: false,
      nextAction: {
        title: "Continue research",
      },
    })
    expect(result).toBeDefined()
    expect(result?.blockingGates ?? []).toEqual([])
  })

  test("returns undefined for invalid schema", () => {
    const result = parseExternalWorkflowSnapshot({
      version: "1",
      source: "external-provider",
      blocking: "yes",
    })
    expect(result).toBeUndefined()
  })
})

describe("loadExternalWorkflowSnapshot", () => {
  test("loads a valid snapshot file", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "workflow.json")
    await Bun.write(
      file,
      JSON.stringify({
        version: 1,
        source: "external-provider",
        taskId: "task-1",
        currentPhase: "P2",
        topLevelStep: "Спецификация",
      }),
    )
    const result = await loadExternalWorkflowSnapshot(file)
    expect(result?.taskId).toBe("task-1")
    expect(result?.currentPhase).toBe("P2")
  })

  test("returns undefined when the file is missing", async () => {
    await using tmp = await tmpdir()
    const result = await loadExternalWorkflowSnapshot(path.join(tmp.path, "missing.json"))
    expect(result).toBeUndefined()
  })

  test("returns undefined for invalid json", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "workflow.json")
    await Bun.write(file, "{not-json")
    const result = await loadExternalWorkflowSnapshot(file)
    expect(result).toBeUndefined()
  })

  test("returns undefined for valid json with invalid schema", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "workflow.json")
    await Bun.write(
      file,
      JSON.stringify({
        version: 1,
        source: "external-provider",
        blocking: "yes",
      }),
    )
    const result = await loadExternalWorkflowSnapshot(file)
    expect(result).toBeUndefined()
  })
})

describe("resolveWorkflowStateFile", () => {
  test("prefers the per-run workflow state file over env fallback", () => {
    expect(resolveWorkflowStateFile("/tmp/run.json", "/tmp/env.json")).toBe("/tmp/run.json")
  })

  test("falls back to env when the run does not provide a file", () => {
    expect(resolveWorkflowStateFile(undefined, "/tmp/env.json")).toBe("/tmp/env.json")
  })
})

describe("mergeExternalWorkflowStatus", () => {
  test("lets a valid external snapshot override currentPhase and enrich status", () => {
    const merged = mergeExternalWorkflowStatus(
      { status: "completed", agentCount: 0, currentPhase: "internal-phase" },
      {
        version: 1,
        source: "external-provider",
        currentPhase: "external-phase",
        topLevelStep: "External step",
        blocking: true,
        blockingGates: ["G5"],
        nextAction: { title: "Unblock", reason: "Need implementation" },
        readinessVerdict: "blocked",
      },
    )
    expect(merged.currentPhase).toBe("external-phase")
    expect(merged.topLevelStep).toBe("External step")
    expect(merged.blocking).toBe(true)
    expect(merged.blockingGates).toEqual(["G5"])
    expect(merged.nextAction).toEqual({ title: "Unblock", reason: "Need implementation" })
    expect(merged.readinessVerdict).toBe("blocked")
    expect(merged.workflowSource).toBe("external-provider")
  })

  test("keeps internal currentPhase when external snapshot is absent", () => {
    const merged = mergeExternalWorkflowStatus({ status: "completed", agentCount: 0, currentPhase: "internal-phase" })
    expect(merged.currentPhase).toBe("internal-phase")
    expect(merged.workflowSource).toBeUndefined()
    expect(merged.topLevelStep).toBeUndefined()
  })
})
