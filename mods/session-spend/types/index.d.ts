export type SpendStep = { at: number; usd: number; total: number }

declare module 'claude-code' {
  interface PluginState {
    'session-spend': { total: number; steps: SpendStep[] }
  }
}
