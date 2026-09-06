// Фикстура для test/cli/signal-handlers-exit.test.ts: три формы обработчика сигнала.
const mode = process.argv[2]
if (mode === "with-exit") {
  for (const sig of ["SIGTERM", "SIGHUP"] as const) {
    process.once(sig, () => {
      const code = sig === "SIGHUP" ? 129 : 143
      void Promise.race([Promise.resolve(), new Promise(r => setTimeout(r, 2000))]).finally(() => process.exit(code))
    })
  }
} else if (mode === "without-exit") {
  for (const sig of ["SIGTERM", "SIGHUP"] as const) process.once(sig, () => void Promise.resolve())
}
setInterval(() => {}, 1000)
