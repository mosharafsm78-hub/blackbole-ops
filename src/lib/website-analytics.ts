// Date ranges and chart grouping for Website → Home / Analytics (all days are Bangladesh calendar days, "YYYY-MM-DD").

export type RangeKey = "today" | "yesterday" | "7d" | "30d" | "90d" | "month"
export type Granularity = "hour" | "day" | "week" | "month"

export const RANGE_PRESETS: { key: RangeKey; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "7d", label: "Last 7 days" },
  { key: "30d", label: "Last 30 days" },
  { key: "90d", label: "Last 90 days" },
  { key: "month", label: "This month" },
]

const BD = 6 * 3600000
const DAY = 86400000
export const bdToday = (now = Date.now()) => new Date(now + BD).toISOString().slice(0, 10)
export const shiftDay = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10)

export const isRangeKey = (s: unknown): s is RangeKey => RANGE_PRESETS.some((p) => p.key === s)

/** First and last day of a preset. */
export function presetRange(key: RangeKey, now = Date.now()): { fromDay: string; toDay: string } {
  const t = bdToday(now)
  switch (key) {
    case "today": return { fromDay: t, toDay: t }
    case "yesterday": { const y = shiftDay(t, -1); return { fromDay: y, toDay: y } }
    case "7d": return { fromDay: shiftDay(t, -6), toDay: t }
    case "30d": return { fromDay: shiftDay(t, -29), toDay: t }
    case "90d": return { fromDay: shiftDay(t, -89), toDay: t }
    case "month": return { fromDay: `${t.slice(0, 8)}01`, toDay: t }
  }
}

export const fmtDay = (day: string, withYear = false) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}), timeZone: "UTC" })

export const fmtRange = (a: string, b: string) => (a === b ? fmtDay(a, true) : `${fmtDay(a, a.slice(0, 4) !== b.slice(0, 4))} – ${fmtDay(b, true)}`)

/** Monday of the week a day falls in. */
export function weekStart(day: string) {
  const d = new Date(`${day}T00:00:00Z`)
  const back = (d.getUTCDay() + 6) % 7
  return shiftDay(day, -back)
}

/** Which groupings make sense for a range of this many days. */
export function granularities(days: number): Granularity[] {
  if (days <= 1) return ["hour"]
  if (days <= 14) return ["day", "week"]
  return ["day", "week", "month"]
}
export const defaultGranularity = (days: number): Granularity => (days <= 1 ? "hour" : days > 120 ? "week" : "day")

type Point = { day: string; sales: number; orders: number }
export type Bucket = { key: string; label: string; sales: number; orders: number }

/** Group daily points into days, weeks (Mon–Sun) or months. */
export function bucket(daily: Point[], by: Granularity): Bucket[] {
  const out: Bucket[] = []
  const at = new Map<string, Bucket>()
  for (const p of daily) {
    const key = by === "month" ? p.day.slice(0, 7) : by === "week" ? weekStart(p.day) : p.day
    let b = at.get(key)
    if (!b) {
      const label = by === "month"
        ? new Date(`${key}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" })
        : by === "week" ? `Week of ${fmtDay(key)}` : fmtDay(key)
      b = { key, label, sales: 0, orders: 0 }
      at.set(key, b); out.push(b)
    }
    b.sales = Math.round((b.sales + p.sales) * 100) / 100
    b.orders += p.orders
  }
  return out
}

/** Hourly points as chart buckets. */
export const hourBuckets = (hours: { hour: number; sales: number; orders: number }[]): Bucket[] =>
  hours.map((h) => ({ key: String(h.hour), label: `${String(h.hour).padStart(2, "0")}:00`, sales: h.sales, orders: h.orders }))

/** Current and previous period side by side (previous lined up by position, like Shopify's comparison line). */
export function overlay(cur: Bucket[], prev: Bucket[] | null) {
  return cur.map((c, i) => ({ ...c, prevSales: prev?.[i]?.sales ?? null, prevOrders: prev?.[i]?.orders ?? null, prevLabel: prev?.[i]?.label ?? null }))
}

/** Percent change, rounded; null when there is nothing to compare with. */
export function pctChange(now: number | null | undefined, before: number | null | undefined): number | null {
  if (now == null || before == null) return null
  if (before === 0) return now === 0 ? 0 : null
  return Math.round(((now - before) / Math.abs(before)) * 100)
}
