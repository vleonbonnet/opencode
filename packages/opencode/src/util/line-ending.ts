export function normalize(text: string): string {
  return text.replaceAll("\r\n", "\n")
}

export function detect(text: string): "\n" | "\r\n" {
  // Mixed input follows the edit tool's established CRLF preference.
  return text.includes("\r\n") ? "\r\n" : "\n"
}

export function convert(text: string, ending: "\n" | "\r\n"): string {
  const normalized = normalize(text)
  return ending === "\n" ? normalized : normalized.replaceAll("\n", "\r\n")
}

export * as LineEnding from "./line-ending"
