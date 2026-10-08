// List prices per million tokens, and what one API response cost at them.

export type Rates = { input: number; read: number; output: number }

// Most specific first: `opus-5-5` must match before `opus-5`.
const RATES: [string, Rates][] = [
  ['fable-5-1', { input: 10, read: 0.25, output: 50 }],
  ['mythos-5-1', { input: 10, read: 0.25, output: 50 }],
  ['fable-5', { input: 10, read: 1, output: 50 }],
  ['mythos-5', { input: 10, read: 1, output: 50 }],
  ['opus-5-5', { input: 4, read: 0.2, output: 20 }],
  ['opus-5', { input: 5, read: 0.5, output: 25 }],
  ['opus-4-8', { input: 5, read: 0.5, output: 25 }],
  ['opus-4-7', { input: 5, read: 0.5, output: 25 }],
  ['opus-4-6', { input: 5, read: 0.5, output: 25 }],
  ['opus-4-5', { input: 5, read: 0.5, output: 25 }],
  ['opus-4-1', { input: 15, read: 1.5, output: 75 }],
  ['opus-4', { input: 15, read: 1.5, output: 75 }],
  ['sonnet-5-5', { input: 2, read: 0.2, output: 10 }],
  ['sonnet-5', { input: 2, read: 0.2, output: 10 }],
  ['sonnet-4-6', { input: 3, read: 0.3, output: 15 }],
  ['sonnet-4-5', { input: 3, read: 0.3, output: 15 }],
  ['sonnet-4', { input: 3, read: 0.3, output: 15 }],
  ['haiku-5-5', { input: 0.1, read: 0.01, output: 0.5 }],
  ['haiku-4-5', { input: 1, read: 0.1, output: 5 }],
]

// Claude Haiku 5.5 bills prompts over 100K tokens at a higher rate.
const HAIKU_5_5_LONG: Rates = { input: 0.5, read: 0.05, output: 2.5 }

export const ratesFor = (model: string, promptTokens: number): Rates | undefined => {
  const id = model.toLowerCase()
  const hit = RATES.find(([key]) => new RegExp(`claude-${key}(?![0-9])`).test(id))
  if (hit === undefined) return undefined
  return hit[0] === 'haiku-5-5' && promptTokens > 100_000 ? HAIKU_5_5_LONG : hit[1]
}

/** An API response's usage as a transcript records it. */
export type RecordedUsage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number }
  server_tool_use?: { web_search_requests?: number }
  speed?: string
}

const WEB_SEARCH_USD = 0.01

/**
 * What one response cost at list price, or undefined for a model the table
 * does not price. Cache writes are 1.25x input for 5 minutes and 2x for an
 * hour; fast mode doubles the token prices; a web search is $0.01.
 */
export const costOfUsage = (model: string, u: RecordedUsage): number | undefined => {
  const input = u.input_tokens ?? 0
  const read = u.cache_read_input_tokens ?? 0
  const written = u.cache_creation_input_tokens ?? 0
  const rates = ratesFor(model, input + read + written)
  if (rates === undefined) return undefined
  const oneHour = u.cache_creation?.ephemeral_1h_input_tokens ?? 0
  const fiveMinutes = u.cache_creation?.ephemeral_5m_input_tokens ?? written - oneHour
  const tokens =
    input * rates.input +
    fiveMinutes * rates.input * 1.25 +
    oneHour * rates.input * 2 +
    read * rates.read +
    (u.output_tokens ?? 0) * rates.output
  const speed = u.speed === 'fast' ? 2 : 1
  return (tokens / 1e6) * speed + (u.server_tool_use?.web_search_requests ?? 0) * WEB_SEARCH_USD
}
