import { describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import {
  loadExternalWorkflowSnapshot,
  parseExternalWorkflowSnapshot,
} from "../../src/workflow/external-workflow-state"

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
