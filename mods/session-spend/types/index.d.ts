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
    }
  }
}
