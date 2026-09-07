import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { readJailRoots, resolveJailed } from "../../src/tool/tool-script"

// checkpoint-writer edits `<data>/memory/**` with apply_patch but could not READ it: the tree
// sat outside the guest jail, so it invented apply_patch context lines and missed. 23 of its 79
// exec failures were literally `path outside allowed roots` on that path.
//
// The jail is the only thing between a guest script and the filesystem, so the negative below
// matters more than the positive: `auth.json` lives one level above `memory/` and must stay
// unreachable. Widening to `<data>` instead of `<data>/memory` would have handed the OAuth
// token of the subscription to every guest script.

// ВАЖНО: фикстура живёт ВНЕ os.tmpdir(). Первая редакция этого теста клала `data` в /tmp —
// а /tmp сам является корнем джейла, поэтому все негативы «проходили» и доказывали ноль.
// Прибор, который зеленеет по построению, хуже отсутствующего.
const BASE = mkdtempSync(path.join(os.homedir(), ".cache", "kernel-jail-test-"))
afterAll(() => rmSync(BASE, { recursive: true, force: true }))

function fixture() {
  const data = mkdtempSync(path.join(BASE, "data-"))
  const worktree = mkdtempSync(path.join(BASE, "wt-"))
  mkdirSync(path.join(data, "memory", "sessions", "ses_x"), { recursive: true })
  writeFileSync(path.join(data, "memory", "sessions", "ses_x", "checkpoint.md"), "# checkpoint\n")
  writeFileSync(path.join(data, "auth.json"), '{"openai":{"refresh":"СЕКРЕТ"}}\n')
  writeFileSync(path.join(worktree, "src.ts"), "export const a = 1\n")
  return { data, worktree, roots: readJailRoots(worktree, worktree, data, [os.tmpdir()]) }
}

describe("джейл гостевого скрипта: дерево памяти читается, соседи по <data> — нет", () => {
  test("чекпоинт собственной сессии читается", () => {
    const { data, roots } = fixture()
    const p = path.join(data, "memory", "sessions", "ses_x", "checkpoint.md")
    expect(resolveJailed(roots, p, "read")).toBe(p)
  })

  test("MEMORY.md проекта читается", () => {
    const { data, roots } = fixture()
    const p = path.join(data, "memory", "projects", "pid", "MEMORY.md")
    mkdirSync(path.dirname(p), { recursive: true })
    writeFileSync(p, "# Project memory\n")
    expect(resolveJailed(roots, p, "read")).toBe(p)
  })

  test("рабочее дерево читается по-прежнему", () => {
    const { worktree, roots } = fixture()
    const p = path.join(worktree, "src.ts")
    expect(resolveJailed(roots, p, "read")).toBe(p)
  })

  test("НЕГАТИВНЫЙ: auth.json рядом с memory/ недостижим", () => {
    const { data, roots } = fixture()
    expect(() => resolveJailed(roots, path.join(data, "auth.json"), "read")).toThrow(/outside allowed roots/)
  })

  test("НЕГАТИВНЫЙ: сам <data> недостижим, расширение ровно на memory/", () => {
    const { data, roots } = fixture()
    expect(() => resolveJailed(roots, data, "read")).toThrow(/outside allowed roots/)
    expect(() => resolveJailed(roots, path.join(data, "mimocode.db"), "read")).toThrow(/outside allowed roots/)
  })

  test("НЕГАТИВНЫЙ: выход по .. из memory/ не работает", () => {
    const { data, roots } = fixture()
    const escape = path.join(data, "memory", "..", "auth.json")
    expect(() => resolveJailed(roots, escape, "read")).toThrow(/outside allowed roots/)
  })

  test("НЕГАТИВНЫЙ: ЗАПИСЬ в дерево памяти остаётся запрещённой — только tmp", () => {
    // Писать в память нужно через apply_patch: он проходит через разрешения и виден в ревью.
    const { data } = fixture()
    const writeRoots = [os.tmpdir()]
    const p = path.join(data, "memory", "projects", "pid", "MEMORY.md")
    expect(() => resolveJailed(writeRoots, p, "write")).toThrow(/limited to the OS temp dir/)
  })

  test("состав корней: ровно четыре, и memory последним", () => {
    const roots = readJailRoots("/wt", "/dir", "/data", ["/tmp1", "/tmp2"])
    expect(roots).toEqual(["/wt", "/tmp1", "/tmp2", path.join("/data", "memory")])
  })

  test("worktree === \"/\" подменяется каталогом проекта (иначе джейл — весь диск)", () => {
    expect(readJailRoots("/", "/proj", "/data", [])[0]).toBe("/proj")
  })
})
