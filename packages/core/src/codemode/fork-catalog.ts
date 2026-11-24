export * as ForkCodeModeCatalog from "./fork-catalog.js"

import type { CodeModeCatalog } from "./catalog.js"

// Fork: the session's Code Mode catalog lists every tool by name, and shows a full signature only for the tools
// pinned here. Upstream pins its own tools and spends a token budget on more signatures in path order, so
// alphabetical accidents filled every session's context. Models find any other signature with `search`. Upstream's
// catalog code and defaults are unchanged; the session passes this inventory and budget.

/** Tools the catalog always shows with their full signature, by path such as `opencode.session.move`. */
export const pinned: ReadonlySet<string> = new Set<string>()

/** Tokens spent on signatures beyond the pinned ones, in the catalog and in its change notices. */
export const signatureBudget = 0

/** INVENTORY with the fork's pins in place of the ones tools register upstream. */
export function adapt(inventory: CodeModeCatalog.Inventory | undefined) {
  if (inventory === undefined) return undefined
  return { ...inventory, tools: inventory.tools.map((entry) => repin(entry, [])) }
}

function repin(
  entry: CodeModeCatalog.Tool | CodeModeCatalog.Namespace,
  path: ReadonlyArray<string>,
): CodeModeCatalog.Tool | CodeModeCatalog.Namespace {
  const at = [...path, entry.name]
  if (entry.type === "namespace") return { ...entry, tools: entry.tools.map((child) => repin(child, at)) }
  // Copied by descriptor: a tool's signature is a getter, rendered only for the tools the catalog shows.
  const tool = Object.defineProperties({}, Object.getOwnPropertyDescriptors(entry)) as CodeModeCatalog.Tool
  Object.defineProperty(tool, "pinned", { value: pinned.has(at.join(".")), enumerable: true })
  return tool
}
