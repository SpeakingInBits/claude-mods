import type { ElementTable } from 'claude-code'

import type { ConversationRow } from '../types'
import { usd } from './card'
import { dayKey } from './history'

export const BREAKDOWN_PANE = 'spend-breakdown'

export type BreakdownData = {
  rows: ConversationRow[] | null
  sort: string
  isRefreshing: boolean
  columns: number
}

export type BreakdownActions = {
  onSort: (value: string) => void
  onClose: () => void
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export const shortDay = (ms: number): string => {
  const d = dayKey(ms)
  return `${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(8, 10)}`
}

const SORTS = [
  { value: 'cost', label: 'Most expensive' },
  { value: 'recent', label: 'Most recent' },
]

const shareBar = (v: number, max: number, width = 10) =>
  '█'.repeat(max > 0 ? Math.max(1, Math.round((v / max) * width)) : 0)

type Table = Pick<ElementTable<'mobile'>, 'Box' | 'Text' | 'Button'> &
  Partial<Pick<ElementTable<'desktop'>, 'Select'>>

/** Every conversation's spend, one row each, in a pane that acts as a dialog. */
export const drawBreakdown = (ui: Table, d: BreakdownData, act: BreakdownActions) => {
  const { Box, Text, Button, Select } = ui
  const rows = [...(d.rows ?? [])].sort((a, b) =>
    d.sort === 'recent' ? b.updatedAt - a.updatedAt : b.usd - a.usd,
  )
  const total = rows.reduce((a, r) => a + r.usd, 0)
  const max = Math.max(...rows.map(r => r.usd), 0)
  const estimates = rows.filter(r => !r.isExact).length

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" gap={2} flexWrap="wrap" alignItems="center">
        <Text bold>
          {rows.length} conversation{rows.length === 1 ? '' : 's'} · {usd(total)}
        </Text>
        {Select && (
          <Select
            key="sort"
            label="Sort"
            options={SORTS}
            value={d.sort}
            onSelect={value => act.onSort(value)}
          />
        )}
        <Button key="close" label="Close" role="dismiss" onPress={() => act.onClose()} />
      </Box>
      {d.isRefreshing && <Text dimColor>Reading changed transcripts…</Text>}
      {d.rows === null && <Text dimColor>Loading…</Text>}
      {d.rows !== null && rows.length === 0 && (
        <Text dimColor>No spend recorded yet. /spend import reads your saved transcripts.</Text>
      )}
      <Box flexDirection="column">
        {rows.map(r => (
          <Box key={`row-${r.id}`} flexDirection="column" marginBottom={1}>
            <Box flexDirection="row" gap={2}>
              <Box width={6} flexShrink={0}>
                <Text dimColor>{shortDay(r.updatedAt)}</Text>
              </Box>
              <Box width={9} flexShrink={0} justifyContent="flex-end">
                <Text bold={r.isCurrent}>{`${r.isExact ? '' : '~'}${usd(r.usd)}`}</Text>
              </Box>
              <Box width={10} flexShrink={0}>
                <Text color="claude">{shareBar(r.usd, max)}</Text>
              </Box>
              <Text wrap="truncate-end" color={r.isCurrent ? 'claude' : undefined}>
                {r.title}
                {r.isCurrent ? ' (this conversation)' : ''}
              </Text>
            </Box>
            <Box flexDirection="row" paddingLeft={8}>
              <Text dimColor wrap="truncate-end">
                {[r.project, r.models.join(', '), r.isExact ? 'exact' : 'estimate']
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
            </Box>
          </Box>
        ))}
      </Box>
      {estimates > 0 && (
        <Text dimColor>
          ~ marks an estimate at list price from a transcript; the rest are exact, as /cost
          reports them.
        </Text>
      )}
    </Box>
  )
}
