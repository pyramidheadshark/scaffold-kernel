export interface LateBoundRef<T> {
  current: T | undefined
  install(value: T | undefined): symbol
  release(token: symbol): void
}

export function createLateBoundRef<T>(): LateBoundRef<T> {
  const stack: Array<{ token: symbol; value: T | undefined }> = []
  let current: T | undefined = undefined

  return {
    get current() {
      return current
    },
    set current(value) {
      stack.length = 0
      current = value
    },
    install(value) {
      const token = Symbol("late-bound-ref")
      stack.push({ token, value })
      current = value
      return token
    },
    release(token) {
      const idx = stack.findIndex((entry) => entry.token === token)
      if (idx >= 0) stack.splice(idx, 1)
      current = stack.at(-1)?.value
    },
  }
}
