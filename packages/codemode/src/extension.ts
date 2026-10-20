export * as Extension from "./extension.js"

/**
 * Host functions a program calls directly as globals. Values crossing in either direction are converted, never
 * shared: arguments come in as copies, results go out as copies, and a function inside a result is callable the
 * same way. A global that returns an Effect runs it in the calling execution's context, with the runtime's services
 * and inside its extension hooks, and the program awaits its result; like a returned promise it runs concurrently
 * with the program, and ending the execution interrupts it. Extension calls are not tool calls.
 */
export type Extension = {
  readonly name: string
  readonly globals: Readonly<Record<string, Function>>
}

export const make = (options: Extension): Extension => {
  for (const [name, value] of Object.entries(options.globals)) {
    if (typeof value !== "function") {
      throw new TypeError(`Extension "${options.name}" global "${name}" must be a function.`)
    }
  }
  return { name: options.name, globals: { ...options.globals } }
}
