// Pixel art for the spend card: drawn as SVG on the desktop, VS Code and
// mobile, and as half-block cells (two pixels to a cell) in the terminal.

export type Sprite = string[]
export type Palette = Record<string, number>

const OUTLINE = 0x2b2b3a

const BIT_IDLE: Sprite = [
  '............',
  '...KKKKKK...',
  '..KSSSSSSK..',
  '.KSHSSSSSSK.',
  '.KSSWESWESK.',
  '.KSSWESWESK.',
  '.KSSSSSSSSK.',
  '.KSSSKKSSSK.',
  '.KSSSSSSSSK.',
  '..KSSSSSSK..',
  '..KSK..KSK..',
  '..KK....KK..',
]

const BIT_HOP: Sprite = [
  '...KKKKKK...',
  '..KSSSSSSK..',
  '.KSHSSSSSSK.',
  '.KSSSWESWEK.',
  '.KSSSWESWEK.',
  '.KSSSSSSSSK.',
  '.KSSSSKKSSK.',
  '.KSSSSKKSSK.',
  '..KSSSSSSK..',
  '.KSK....KSK.',
  '.KK......KK.',
  '............',
]

export const BIT_PALETTE: Palette = {
  K: OUTLINE,
  S: 0xd97757,
  H: 0xf2a07b,
  W: 0xffffff,
  E: 0x1d1d28,
  G: 0xf5c542,
  Y: 0xfff1a8,
  g: 0xb8860b,
  h: 0xe6f7ff,
  i: 0x9ad8f5,
  d: 0x6bb8e0,
  w: 0x5aa9e6,
}

// Bit's ice cube melts as the prompt cache nears expiry: stage 0 to 3.
const ICE: Sprite[] = [
  [
    '..........',
    '..........',
    '.KKKKKKKK.',
    '.KhhiiiiK.',
    '.KhiiiiiK.',
    '.KiiiiiiK.',
    '.KiiiiidK.',
    '.KiiiiddK.',
    '.KKKKKKKK.',
    '..........',
  ],
  [
    '..........',
    '..........',
    '..........',
    '..........',
    '.KKKKKKKK.',
    '.KhhiiiiK.',
    '.KiiiiidK.',
    '.KKKKKKKK.',
    '..w.......',
    '.wwww.....',
  ],
  [
    '..........',
    '..........',
    '..........',
    '..........',
    '..........',
    '..........',
    '...KKKK...',
    '...KhdK...',
    '...KKKK...',
    '.wwwwwwww.',
  ],
  [
    '..........',
    '..........',
    '..........',
    '..........',
    '..........',
    '..........',
    '..........',
    '..........',
    '..wwwwww..',
    'wwwwwwwwww',
  ],
]

const COIN_TOP = '.GYG.'
const COIN_EDGE = 'ggggg'

/** How many coins Bit stands beside: one more each time the spend passes a tier. */
export const coinsFor = (usd: number): number =>
  usd <= 0 ? 0 : [0.05, 0.25, 1, 5, 20].filter(t => usd >= t).length + 1

/**
 * Bit, a gap, and a stack of up to six coins (18 by 12 pixels), then the ice
 * cube at its melt stage when there is a cache to show (29 by 12).
 */
export const bitWithCoins = (
  isWorking: boolean,
  frame: number,
  coins: number,
  melt?: number,
): Sprite => {
  const body = isWorking && frame % 2 === 1 ? BIT_HOP : BIT_IDLE
  const stack = Array.from({ length: 12 }, () => '.....')
  for (let i = 0; i < Math.min(coins, 6); i++) {
    stack[11 - i * 2] = COIN_EDGE
    stack[10 - i * 2] = COIN_TOP
  }
  const ice = melt === undefined ? undefined : ICE[Math.max(0, Math.min(3, melt))]!
  return body.map((row, y) => {
    const base = `${row}.${stack[y]}`
    return ice === undefined ? base : `${base}.${ice[y - 2] ?? '..........'}`
  })
}

const AGENT_A: Sprite = [
  '...KK...',
  '..KCCK..',
  '.KCCCCK.',
  'KCWCCWCK',
  'KCCCCCCK',
  '.KCDDCK.',
  '.KC..CK.',
  '.KK..KK.',
]

const AGENT_B: Sprite = [
  '...KK...',
  '..KCCK..',
  '.KCCCCK.',
  'KCWCCWCK',
  'KCCCCCCK',
  '.KCDDCK.',
  '..KCCK..',
  '..KKKK..',
]

const AGENT_DONE: Sprite = AGENT_A.map((row, y) => (y === 3 ? 'KCKCCKCK' : row))
const AGENT_FAILED: Sprite = AGENT_A.map((row, y) => (y === 3 ? 'KCRCCRCK' : row))

const TYPE_COLORS: Record<string, number> = {
  'general-purpose': 0x5b8def,
  Explore: 0x3fb6a8,
  Plan: 0xa77bdb,
}
const SPARE_COLORS = [0xe0b341, 0xe06c75, 0x7fc97f, 0xf08a4b, 0x4fc1e9, 0xd16ba5]

export const colorForType = (type: string): number => {
  const known = TYPE_COLORS[type]
  if (known !== undefined) return known
  let hash = 0
  for (const ch of type) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return SPARE_COLORS[hash % SPARE_COLORS.length]!
}

const darken = (c: number, f: number): number =>
  (Math.round(((c >> 16) & 255) * f) << 16) |
  (Math.round(((c >> 8) & 255) * f) << 8) |
  Math.round((c & 255) * f)

const toGray = (c: number): number => {
  const l = Math.round(((c >> 16) & 255) * 0.3 + ((c >> 8) & 255) * 0.59 + (c & 255) * 0.11)
  return (l << 16) | (l << 8) | l
}

type AgentLook = 'running' | 'done' | 'failed'

export const agentSprite = (state: AgentLook, frame: number): Sprite =>
  state === 'done'
    ? AGENT_DONE
    : state === 'failed'
      ? AGENT_FAILED
      : frame % 2 === 1
        ? AGENT_B
        : AGENT_A

export const agentPalette = (type: string, state: AgentLook): Palette => {
  const base = colorForType(type)
  const body = state === 'running' ? base : state === 'done' ? darken(base, 0.75) : toGray(base)
  return { K: OUTLINE, C: body, D: darken(body, 0.6), W: 0xffffff, R: 0xe5484d }
}

export const hex = (c: number): string => `#${c.toString(16).padStart(6, '0')}`

const svg = (w: number, h: number, scale: number, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w * scale}" height="${h * scale}" ` +
  `viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges">${body}</svg>`

/** The sprite as SVG, `scale` CSS pixels to a sprite pixel, runs merged. */
export const toSvg = (sprite: Sprite, palette: Palette, scale: number): string => {
  const w = sprite[0]!.length
  const rects: string[] = []
  sprite.forEach((row, y) => {
    let x = 0
    while (x < w) {
      const ch = row[x]!
      const color = palette[ch]
      let run = 1
      while (x + run < w && row[x + run] === ch) run++
      if (color !== undefined) {
        rects.push(`<rect x="${x}" y="${y}" width="${run}" height="1" fill="${hex(color)}"/>`)
      }
      x += run
    }
  })
  return svg(w, sprite.length, scale, rects.join(''))
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export const base64 = (bytes: Uint8Array): string => {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    const n = (bytes[i]! << 16) | ((b ?? 0) << 8) | (c ?? 0)
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!
    out += b === undefined ? '=' : B64[(n >> 6) & 63]!
    out += c === undefined ? '=' : B64[n & 63]!
  }
  return out
}

const DEFAULT_COLOR = 0x01000000
const UPPER_HALF = 0x2580
const LOWER_HALF = 0x2584

export type RasterCells = { columns: number; rows: number; cells: string }

/**
 * The sprite as a terminal Raster: each cell holds two pixels, the upper as
 * an upper-half block's foreground and the lower as its background.
 */
export const toRaster = (sprite: Sprite, palette: Palette): RasterCells => {
  const columns = sprite[0]!.length
  const rows = Math.ceil(sprite.length / 2)
  const words = new Uint32Array(columns * rows * 3)
  for (let r = 0; r < rows; r++) {
    for (let x = 0; x < columns; x++) {
      const top = palette[sprite[r * 2]?.[x] ?? '.']
      const bottom = palette[sprite[r * 2 + 1]?.[x] ?? '.']
      const i = (r * columns + x) * 3
      if (top === undefined && bottom === undefined) {
        words.set([0x20, DEFAULT_COLOR, DEFAULT_COLOR], i)
      } else if (top === undefined) {
        words.set([LOWER_HALF, bottom!, DEFAULT_COLOR], i)
      } else {
        words.set([UPPER_HALF, top, bottom ?? DEFAULT_COLOR], i)
      }
    }
  }
  return { columns, rows, cells: base64(new Uint8Array(words.buffer)) }
}

/** A row of pixel blocks: `fraction` of `segments` lit in `color`. */
export const meterSvg = (fraction: number, color: number, segments = 20): string => {
  const lit = Math.round(Math.max(0, Math.min(1, fraction)) * segments)
  const rects = Array.from({ length: segments }, (_, i) => {
    const fill = i < lit ? hex(color) : '#88888855'
    return `<rect x="${i * 3}" y="0" width="2" height="2" fill="${fill}"/>`
  })
  return svg(segments * 3 - 1, 2, 4, rects.join(''))
}

export const meterText = (fraction: number, segments = 20): [string, string] => {
  const lit = Math.round(Math.max(0, Math.min(1, fraction)) * segments)
  return ['█'.repeat(lit), '░'.repeat(segments - lit)]
}

/** Per-turn spend as pixel columns, the tallest the priciest turn shown. */
export const sparkSvg = (values: number[], color: number): string => {
  const h = 6
  const max = Math.max(...values, 0)
  const rects = values.map((v, i) => {
    const bar = max > 0 ? Math.max(1, Math.round((v / max) * h)) : 1
    return `<rect x="${i * 2}" y="${h - bar}" width="1" height="${bar}" fill="${hex(color)}"/>`
  })
  return svg(Math.max(1, values.length * 2 - 1), h, 4, rects.join(''))
}

const SPARK = '▁▂▃▄▅▆▇█'

export const sparkText = (values: number[]): string => {
  const max = Math.max(...values, 0)
  return values
    .map(v => SPARK[max > 0 ? Math.min(7, Math.floor((v / max) * 7.999)) : 0])
    .join('')
}

export const meterColor = (percent: number): number =>
  percent >= 90 ? 0xe5484d : percent >= 70 ? 0xe0b341 : 0x46a758
