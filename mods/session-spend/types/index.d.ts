export type SpendStep = { at: number; usd: number; total: number }

/** One plan usage window, as `$.session.usage()` reports it. */
export type RateLimit = { kind: string; percentUsed: number; resetsAt?: string }

/** The main thread's last model request: when it started and what it carried. */
export type CacheWindow = {
  startedAt: number
  model: string
  prefixTokens: number
  outputTokens: number
}

/** Spend in every other session, and the running session's share of today. */
export type AllTime = {
  othersTotal: number
  othersToday: number
  othersSessions: number
  /** The day `othersToday` counts, `YYYY-MM-DD`. */
  date: string
  ownToday: number
}

/** One conversation in the spending breakdown. */
export type ConversationRow = {
  id: string
  title: string
  project: string
  updatedAt: number
  usd: number
  /** From the ledger (as /cost reports) rather than a transcript estimate. */
  isExact: boolean
  isCurrent: boolean
  /** The models that cost the most in it, at most two. */
  models: string[]
}

export type AgentState = 'running' | 'done' | 'failed'

export type Subagent = {
  id: string
  type: string
  description: string
  state: AgentState
  tokens: number
}

declare module 'claude-code' {
  interface PluginState {
    'session-spend': {
      total: number
      steps: SpendStep[]
      rateLimits: RateLimit[]
      agents: Subagent[]
      isWorking: boolean
      frame: number
      isCardHidden: boolean
      cache: CacheWindow | null
      cacheTick: number
      cacheWarnedFor: number
      allTime: AllTime | null
      breakdown: ConversationRow[] | null
      breakdownSort: string
      isBreakdownRefreshing: boolean
    }
  }
}
