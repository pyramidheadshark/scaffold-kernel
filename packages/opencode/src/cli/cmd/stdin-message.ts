/**
 * Should this invocation read stdin at all?
 *
 * Scaffold, 2026-09-06. Both entry points used to read stdin whenever it was not
 * a TTY, unconditionally: `run.ts` did `message += "\n" + await Bun.stdin.text()`
 * and the TUI's `input()` did the same before merging. `Bun.stdin.text()` waits
 * for EOF, so a parent that leaves an idle pipe open — an agent harness, some
 * cron and wrapper setups — blocked the process forever BEFORE a session was
 * created: no output, no database row, no CPU. From outside that is
 * indistinguishable from a hung model, and it is the failure the caller is least
 * equipped to diagnose.
 *
 * Measured, same prompt, only stdin differs:
 *   sleep 300 | mimo run "reply: HI"     → killed at 90s, 0% CPU, nothing written
 *   mimo run "reply: HI" < /dev/null     → exit 0 in 9.6s
 *
 * The rule: **stdin is read only when it is the sole source of the message.**
 * Piping into a bare `run`/TUI still works (that is the whole point of the pipe);
 * what goes away is appending stdin to a message that was already given as an
 * argument. That concatenation is what makes the wait unbounded in the one case
 * where the caller never intended to pipe anything.
 *
 * One helper, two call sites, deliberately: the two copies of this decision would
 * otherwise drift, and only one of them would ever get fixed.
 */
export async function readMessageFromStdin(input: {
  /** The message supplied as a CLI argument, if any. */
  argument: string | undefined
  /**
   * Whether `--command` was given. It is a source of the task too: with
   * `run --command plan` and no positional message the argument is empty, and the rule
   * "stdin is the only source" wrongly allowed draining it to EOF — an idle pipe hung the
   * run exactly as before the fix.
   */
  hasCommand?: boolean
  /** `process.stdin.isTTY` — a TTY is a human, never a pipe to drain. */
  isTTY: boolean
  /** Reads stdin to EOF. Not called unless the answer is genuinely needed. */
  read: () => Promise<string>
}): Promise<string | undefined> {
  if (input.isTTY) return undefined
  if (input.hasCommand) return undefined
  if ((input.argument ?? "").trim().length > 0) return undefined
  return await input.read()
}
