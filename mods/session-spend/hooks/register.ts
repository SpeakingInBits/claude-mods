import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { SpendStep } from '../types'

const total = atom({ plugin: 'session-spend', key: 'total' } as const, 0)
const steps = atom({ plugin: 'session-spend', key: 'steps' } as const, [])

export const usd = (n: number): string =>
  n < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`

const show = async ($: EngineInterface, now: number, last?: number) => {
  const delta = last !== undefined && last > 0 ? ` (+${usd(last)} last turn)` : ''
  $.ui.status(`API spend ${usd(now)}${delta}`)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'spend',
      description: "Show this session's API spend, turn by turn",
    })
    const ran = await next(e)
    const { cost } = await $.session.usage()
    if (cost !== undefined) {
      await update($, total, () => cost.usd)
      const list = await read($, steps)
      await show($, cost.usd, list.at(-1)?.usd)
    }

    return ran
  })

  on('session.measure', async ($, e, next) => {
    if (e.cost !== undefined && e.changed.includes('cost')) {
      const before = await read($, total)
      const now = e.cost.usd
      const step: SpendStep = {
        at: await $.clock.now(),
        usd: Math.max(0, now - before),
        total: now,
      }
      await update($, total, () => now)
      await update($, steps, list => [...list, step].slice(-500))
      await show($, now, step.usd)
    }

    return next(e)
  })

  on('command.run', { command: 'spend' }, async $ => {
    const { cost, startedAt } = await $.session.usage()
    if (cost === undefined) {
      return { text: 'This host keeps no cost ledger for the session.' }
    }
    const list = await read($, steps)
    const minutes = Math.max(1, Math.round(((await $.clock.now()) - startedAt) / 60000))
    const lines = [
      `Session API spend: ${usd(cost.usd)} over ${minutes} min`,
      `Rate: ${usd((cost.usd / minutes) * 60)}/hour`,
    ]
    const recent = list.slice(-10)
    if (recent.length > 0) {
      lines.push('', `Last ${recent.length} measured step(s):`)
      for (const s of recent) {
        lines.push(`  +${usd(s.usd).padEnd(9)} → ${usd(s.total)}`)
      }
      const priciest = list.reduce((a, b) => (b.usd > a.usd ? b : a))
      lines.push('', `Priciest step: ${usd(priciest.usd)}`)
    }
    lines.push('', 'Estimated at list price (or your managed pricing); subscription plans are not billed per token.')

    return { text: lines.join('\n') }
  })
}
