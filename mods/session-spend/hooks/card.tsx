import type { ElementTable } from 'claude-code'

import type { RateLimit, Subagent } from '../types'
import type { NextCost } from './cache'
import { timeLeft } from './cache'
import {
  agentPalette,
  agentSprite,
  BIT_PALETTE,
  bitWithCoins,
  coinsFor,
  meterColor,
  meterSvg,
  meterText,
  hex,
  sparkSvg,
  sparkText,
  toRaster,
  toSvg,
} from './sprites'

export type CardData = {
  total: number
  turns: number[]
  rateLimits: RateLimit[]
  agents: Subagent[]
  isWorking: boolean
  frame: number
  now: number
  columns: number
  cache?: CacheView
}

/** The prompt cache as the card shows it, worked out by the module. */
export type CacheView = {
  isInUse: boolean
  remaining: number
  ttl: number
  melt: number
  tokens: number
  cost?: NextCost
}

const cacheColor = (c: CacheView): string => {
  const f = c.remaining / c.ttl
  return c.isInUse || f >= 0.5 ? 'success' : f >= 0.2 ? 'warning' : 'error'
}

const cacheStatus = (c: CacheView): string => (c.isInUse ? 'warm, in use' : timeLeft(c.remaining))

export const cacheLine = (c: CacheView): string => {
  if (c.cost === undefined) return `Next prompt re-sends ${tokens(c.tokens)} tok`
  if (c.remaining <= 0 && !c.isInUse) {
    return `Next prompt re-caches ${tokens(c.tokens)} tok ~${usd(c.cost.cold)}`
  }
  return `Next prompt ~${usd(c.cost.warm)}, ~${usd(c.cost.cold)} if expired`
}

const cacheColorHex = (c: CacheView): number => {
  const f = c.isInUse ? 1 : c.remaining / c.ttl
  return f >= 0.5 ? 0x46a758 : f >= 0.2 ? 0xe0b341 : 0xe5484d
}

const cacheFraction = (c: CacheView): number => (c.isInUse ? 1 : c.remaining / c.ttl)

export const usd = (n: number): string => (n < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`)

const tokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`

const KIND_LABELS: Record<string, string> = {
  five_hour: '5h',
  seven_day: '7d',
  seven_day_opus: '7d Opus',
  seven_day_sonnet: '7d Sonnet',
  spend_limit: 'Spend',
}

export const kindLabel = (kind: string): string => KIND_LABELS[kind] ?? kind.replaceAll('_', ' ')

export const resetsIn = (iso: string | undefined, now: number): string => {
  const ms = iso === undefined ? NaN : Date.parse(iso) - now
  if (!(ms > 0)) return ''
  const m = Math.round(ms / 60000)
  if (m < 60) return `resets in ${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `resets in ${h}h ${m % 60}m`
  return `resets in ${Math.floor(h / 24)}d ${h % 24}h`
}

const agentCaption = (a: Subagent): string =>
  a.state === 'running' ? 'working' : a.state === 'failed' ? 'stopped' : `${tokens(a.tokens)} tok`

const agentAlt = (a: Subagent): string =>
  `${a.type} subagent, ${a.state === 'running' ? 'working' : a.state}: ${a.description}`

/** Running agents first, then the newest, as many as `room` allows. */
export const pickAgents = (agents: Subagent[], room: number): Subagent[] => {
  const running = agents.filter(a => a.state === 'running')
  const ended = agents.filter(a => a.state !== 'running').reverse()
  return [...running, ...ended].slice(0, Math.max(0, room))
}

const STATS_COLUMNS = 46
const AGENT_COLUMNS = 10

const recent = (turns: number[]) => turns.slice(-20)

export const drawTerminal = (ui: ElementTable<'terminal'>, d: CardData) => {
  const { Box, Text, Raster } = ui
  const bit = toRaster(
    bitWithCoins(d.isWorking, d.frame, coinsFor(d.total), d.cache?.melt),
    BIT_PALETTE,
  )
  const showBit = d.columns >= bit.columns + 2 + 30
  const room = Math.floor(
    (d.columns - (showBit ? bit.columns + 2 : 0) - STATS_COLUMNS - 2) / AGENT_COLUMNS,
  )
  const shown = pickAgents(d.agents, room)
  const hidden = d.agents.length - shown.length
  const turns = recent(d.turns)
  const cache = d.cache
  const [cacheLit, cacheUnlit] = cache ? meterText(cacheFraction(cache), 10) : ['', '']

  return (
    <Box flexDirection="row" gap={2}>
      {showBit && <Raster key="bit" {...bit} />}
      <Box flexDirection="column" width={Math.min(STATS_COLUMNS, d.columns)}>
        <Text>
          <Text bold color="claude">
            {usd(d.total)}
          </Text>
          <Text dimColor> API spend this session</Text>
        </Text>
        {turns.length > 0 ? (
          <Text>
            <Text color="claude">{sparkText(turns)}</Text>
            <Text dimColor> last {turns.length} turns</Text>
          </Text>
        ) : (
          <Text dimColor>No turns measured yet</Text>
        )}
        {cache && (
          <Text>
            <Text>Cache </Text>
            <Text color={cacheColor(cache)}>{cacheLit}</Text>
            <Text dimColor>{cacheUnlit}</Text>
            <Text color={cacheColor(cache)}> {cacheStatus(cache)}</Text>
          </Text>
        )}
        {cache && <Text dimColor>{cacheLine(cache)}</Text>}
        {d.rateLimits.map(limit => {
          const [lit, unlit] = meterText(limit.percentUsed / 100, 14)
          return (
            <Text key={limit.kind}>
              <Text>{kindLabel(limit.kind).padEnd(4)} </Text>
              <Text color={hex(meterColor(limit.percentUsed))}>{lit}</Text>
              <Text dimColor>{unlit}</Text>
              <Text> {`${Math.round(limit.percentUsed)}%`.padStart(4)}</Text>
              <Text dimColor> {resetsIn(limit.resetsAt, d.now)}</Text>
            </Text>
          )
        })}
        {hidden > 0 && (
          <Text dimColor>
            +{hidden} more subagent{hidden === 1 ? '' : 's'}
          </Text>
        )}
      </Box>
      {shown.map(a => (
        <Box key={`agent-${a.id}`} flexDirection="column" width={AGENT_COLUMNS - 1}>
          <Raster
            key={`sprite-${a.id}`}
            {...toRaster(agentSprite(a.state, d.frame), agentPalette(a.type, a.state))}
          />
          <Text wrap="truncate-end" dimColor={a.state !== 'running'}>
            {a.type}
          </Text>
          <Text wrap="truncate-end" dimColor>
            {agentCaption(a)}
          </Text>
        </Box>
      ))}
    </Box>
  )
}

export const drawDesktop = (ui: Pick<ElementTable<'mobile'>, 'Box' | 'Text' | 'Svg'>, d: CardData) => {
  const { Box, Text, Svg } = ui
  const shown = pickAgents(d.agents, 8)
  const hidden = d.agents.length - shown.length
  const turns = recent(d.turns)
  const coins = coinsFor(d.total)
  const cache = d.cache
  const melt = ['a full ice cube', 'a melting ice cube', 'a nearly melted ice cube', 'a puddle']

  return (
    <Box flexDirection="row" gap={2} flexWrap="wrap" alignItems="center">
      <Svg
        source={toSvg(bitWithCoins(d.isWorking, d.frame, coins, cache?.melt), BIT_PALETTE, 4)}
        alt={`Bit, ${d.isWorking ? 'hopping while Claude works' : 'standing by'}, beside ${coins} coin${coins === 1 ? '' : 's'}${cache ? ` and ${melt[cache.melt]}` : ''}`}
      />
      <Box flexDirection="column" gap={0}>
        <Text>
          <Text bold color="claude">
            {usd(d.total)}
          </Text>
          <Text dimColor> API spend this session</Text>
        </Text>
        {turns.length > 0 ? (
          <Box flexDirection="row" gap={1} alignItems="flex-end">
            <Svg
              source={sparkSvg(turns, 0xd97757)}
              alt={`Spend per turn over the last ${turns.length} turns, the latest ${usd(turns.at(-1) ?? 0)}`}
            />
            <Text dimColor>last {turns.length} turns</Text>
          </Box>
        ) : (
          <Text dimColor>No turns measured yet</Text>
        )}
        {cache && (
          <Box flexDirection="row" gap={1} alignItems="center">
            <Text>Cache</Text>
            <Svg
              source={meterSvg(cacheFraction(cache), cacheColorHex(cache), 10)}
              alt={`Prompt cache ${cacheStatus(cache)}`}
            />
            <Text color={cacheColor(cache)}>{cacheStatus(cache)}</Text>
          </Box>
        )}
        {cache && <Text dimColor>{cacheLine(cache)}</Text>}
        {d.rateLimits.map(limit => (
          <Box key={limit.kind} flexDirection="row" gap={1} alignItems="center">
            <Text>{kindLabel(limit.kind)}</Text>
            <Svg
              source={meterSvg(limit.percentUsed / 100, meterColor(limit.percentUsed))}
              alt={`${kindLabel(limit.kind)} plan usage ${Math.round(limit.percentUsed)}%`}
            />
            <Text>{Math.round(limit.percentUsed)}%</Text>
            <Text dimColor>{resetsIn(limit.resetsAt, d.now)}</Text>
          </Box>
        ))}
      </Box>
      {shown.map(a => (
        <Box key={`agent-${a.id}`} flexDirection="column" alignItems="center">
          <Svg
            source={toSvg(agentSprite(a.state, d.frame), agentPalette(a.type, a.state), 4)}
            alt={agentAlt(a)}
          />
          <Text dimColor={a.state !== 'running'}>{a.type}</Text>
          <Text dimColor>{agentCaption(a)}</Text>
        </Box>
      ))}
      {hidden > 0 && <Text dimColor>+{hidden} more</Text>}
    </Box>
  )
}
