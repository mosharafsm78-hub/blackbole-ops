// Menu editor helpers (Website → Navigation): a menu is edited as a flat list with a depth per row (0–2, like
// Shopify's three levels), so one drag can both reorder and nest. These turn the tree into rows and back.
export type MenuItem = { title: string; url: string; type?: string; items: MenuItem[] }
export type Row = { key: string; title: string; url: string; type: string; depth: number }

export const MAX_DEPTH = 2 // 0, 1, 2 = three levels

let seq = 0
export const newKey = () => `m${Date.now().toString(36)}${(seq++).toString(36)}`

export function flatten(items: MenuItem[], depth = 0, out: Row[] = []): Row[] {
  for (const i of items ?? []) {
    out.push({ key: newKey(), title: i.title ?? "", url: i.url ?? "", type: i.type ?? "HTTP", depth: Math.min(depth, MAX_DEPTH) })
    if (depth < MAX_DEPTH) flatten(i.items ?? [], depth + 1, out)
  }
  return out
}

/** Makes every depth valid: first row 0, never more than one deeper than the row above, never past MAX_DEPTH. */
export function normalize(rows: Row[]): Row[] {
  let prev = -1
  return rows.map((r) => {
    const depth = Math.max(0, Math.min(r.depth, prev + 1, MAX_DEPTH))
    prev = depth
    return depth === r.depth ? r : { ...r, depth }
  })
}

export function build(rows: Row[]): MenuItem[] {
  const root: MenuItem[] = []
  const stack: MenuItem[][] = [root]
  for (const r of normalize(rows)) {
    const item: MenuItem = { title: r.title, url: r.url, type: r.type, items: [] }
    stack.length = r.depth + 1
    stack[r.depth].push(item)
    stack[r.depth + 1] = item.items
  }
  return root
}

/** Index after the last row of the block that starts at `i` (the row and everything nested under it). */
export function blockEnd(rows: Row[], i: number) {
  let j = i + 1
  while (j < rows.length && rows[j].depth > rows[i].depth) j++
  return j
}

/** Deepest level below a row, counted from the row (0 = no sub-links). */
export function blockSpan(rows: Row[], i: number) {
  let m = 0
  for (let j = i + 1; j < blockEnd(rows, i); j++) m = Math.max(m, rows[j].depth - rows[i].depth)
  return m
}

/** Allowed levels for a block of rows moved to sit right after `prev` (undefined = at the top). */
export function depthRange(prev: Row | undefined, span: number) {
  const max = Math.max(0, Math.min(prev ? prev.depth + 1 : 0, MAX_DEPTH - span))
  return { min: 0, max }
}

/**
 * Moves the row at `from` (with its sub-links) so it lands before row `to` (an index in the current list; rows.length
 * = at the end), at level `depth` (clamped to what is allowed there).
 */
export function moveBlock(rows: Row[], from: number, to: number, depth: number): Row[] {
  const end = blockEnd(rows, from)
  if (to > from && to < end) return rows // can't drop a link inside itself
  const block = rows.slice(from, end)
  const rest = [...rows.slice(0, from), ...rows.slice(end)]
  const at = to > from ? to - block.length : to
  const span = blockSpan(rows, from)
  const { min, max } = depthRange(rest[at - 1], span)
  const d = Math.max(min, Math.min(depth, max))
  const shift = d - rows[from].depth
  const moved = block.map((r) => ({ ...r, depth: r.depth + shift }))
  return normalize([...rest.slice(0, at), ...moved, ...rest.slice(at)])
}

/** Indent (+1) or outdent (-1) a row with its sub-links. */
export function shiftBlock(rows: Row[], i: number, by: 1 | -1): Row[] {
  return moveBlock(rows, i, i, rows[i].depth + by)
}

export function removeBlock(rows: Row[], i: number): Row[] {
  return normalize([...rows.slice(0, i), ...rows.slice(blockEnd(rows, i))])
}

/** Inserts a new row as the last sub-link of row `parent` (or at the end when parent is -1). */
export function addChild(rows: Row[], parent: number, row: Omit<Row, "depth" | "key">): Row[] {
  if (parent < 0) return [...rows, { ...row, key: newKey(), depth: 0 }]
  const end = blockEnd(rows, parent)
  const depth = Math.min(rows[parent].depth + 1, MAX_DEPTH)
  return normalize([...rows.slice(0, end), { ...row, key: newKey(), depth }, ...rows.slice(end)])
}

// ---------------------------------------------------------------- URL redirects CSV (Shopify's format)
const cell = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
export function redirectsToCsv(rows: { path: string; target: string }[]) {
  return ["Redirect from,Redirect to", ...rows.map((r) => `${cell(r.path)},${cell(r.target)}`)].join("\n") + "\n"
}
/** Rows from a parsed CSV: Shopify's "Redirect from, Redirect to" header (any order), or just two columns. */
export function redirectsFromCsv(table: string[][]) {
  if (!table.length) return []
  const head = table[0].map((h) => h.trim().toLowerCase())
  const fi = head.findIndex((h) => /from|old|path|source/.test(h))
  const ti = head.findIndex((h, i) => i !== fi && /\bto\b|target|new|destination/.test(h))
  const hasHead = fi >= 0 && ti >= 0
  const [a, b] = hasHead ? [fi, ti] : [0, 1]
  return (hasHead ? table.slice(1) : table)
    .map((r) => ({ path: (r[a] ?? "").trim(), target: (r[b] ?? "").trim() }))
    .filter((r) => r.path || r.target)
}

/** Number of links in a menu tree (all levels). */
export function countItems(items: MenuItem[]): number {
  return (items ?? []).reduce((n, i) => n + 1 + countItems(i.items ?? []), 0)
}
