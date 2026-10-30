// Pure maths for the company revenue target — no database, no Convex imports, so it can be tested on its own.
//
// Revenue here means exactly what the Accounting dashboard calls sales revenue: the `total` of orders that
// reached a delivered status, counted on the Dhaka calendar day they were DELIVERED (not the day they were
// ordered). A month's target is split into daily targets that RE-BALANCE every day: each day's target is what
// is still missing from the month divided by the days still left (that day included). A slow day therefore
// raises tomorrow's target, a big day lowers it, and a month that is already beaten asks for nothing more.

const BD = 6 * 3600000 // Asia/Dhaka, UTC+6, no daylight saving
const DAY = 86400000

/** "2026-11-05" — the Dhaka calendar day of a timestamp. */
export const dhakaDay = (t: number) => new Date(t + BD).toISOString().slice(0, 10)

/** "2026-11" — the Dhaka calendar month of a timestamp. */
export const dhakaMonth = (t: number) => dhakaDay(t).slice(0, 7)

export const isMonthKey = (s: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(s)

export function daysInMonth(month: string) {
  const [y, m] = month.split("-").map(Number)
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

/** First instant of the month in Dhaka, as epoch ms. */
export const monthStartMs = (month: string) => {
  const [y, m] = month.split("-").map(Number)
  return Date.UTC(y, m - 1, 1) - BD
}

/** First instant of the NEXT month in Dhaka, as epoch ms (use as an exclusive upper bound). */
export const monthEndMs = (month: string) => monthStartMs(month) + daysInMonth(month) * DAY

export function nextMonthKey(month: string) {
  const [y, m] = month.split("-").map(Number)
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`
}

export function prevMonthKey(month: string) {
  const [y, m] = month.split("-").map(Number)
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`
}

/** Adds up delivered order rows into a { "YYYY-MM-DD": taka } map by their Dhaka delivery day. */
export function sumDeliveredByDay(rows: { at: number; total: number }[]) {
  const out: Record<string, number> = {}
  for (const r of rows) {
    const d = dhakaDay(r.at)
    out[d] = Math.round(((out[d] ?? 0) + r.total) * 100) / 100
  }
  return out
}

export type DayPlan = {
  day: string
  /** What this day needed to deliver, worked out at the start of that day from what was missing then. */
  target: number
  delivered: number
  hit: boolean
  isToday: boolean
}

export type MonthPlan = {
  month: string
  target: number
  delivered: number
  remaining: number
  /** Share of the month's target delivered so far, 0–100+ (can pass 100 when beaten). */
  pct: number
  daysInMonth: number
  /** Days left INCLUDING today; 0 once the month is over (or 0 before it starts: see `started`). */
  daysLeft: number
  started: boolean
  finished: boolean
  today: { day: string; target: number; delivered: number; toGo: number } | null
  /** What each remaining day AFTER today must deliver to still land the month; 0 when nothing is left to ask. */
  perDayFromTomorrow: number
  days: DayPlan[]
}

/**
 * Builds the month's plan up to and including `today` (a Dhaka "YYYY-MM-DD").
 * `deliveredByDay` holds delivered revenue per Dhaka day. Targets are whole taka, rounded UP so that hitting
 * every day's target always meets the month.
 */
export function planMonth(args: { month: string; target: number; deliveredByDay: Record<string, number>; today: string }): MonthPlan {
  const { month, target, deliveredByDay, today } = args
  const n = daysInMonth(month)
  const first = `${month}-01`
  const last = `${month}-${String(n).padStart(2, "0")}`
  const started = today >= first
  const finished = today > last

  const days: DayPlan[] = []
  let cumulative = 0
  for (let i = 1; i <= n; i++) {
    const day = `${month}-${String(i).padStart(2, "0")}`
    if (day > today) break
    const left = n - i + 1 // days left at the start of this day, itself included
    const need = Math.max(0, target - cumulative)
    const dayTarget = Math.ceil(need / left)
    const delivered = deliveredByDay[day] ?? 0
    days.push({ day, target: dayTarget, delivered, hit: delivered >= dayTarget, isToday: day === today })
    cumulative += delivered
  }

  const delivered = Math.round(Object.entries(deliveredByDay).filter(([d]) => d >= first && d <= last).reduce((s, [, v]) => s + v, 0) * 100) / 100
  const remaining = Math.max(0, target - delivered)
  const todayRow = days.find((d) => d.isToday) ?? null
  const daysLeft = !started ? n : finished ? 0 : n - Number(today.slice(8, 10)) + 1
  const afterToday = started ? Math.max(0, daysLeft - 1) : 0

  return {
    month, target, delivered, remaining,
    pct: target > 0 ? Math.round((delivered / target) * 1000) / 10 : 0,
    daysInMonth: n, daysLeft, started, finished,
    today: todayRow ? { day: todayRow.day, target: todayRow.target, delivered: todayRow.delivered, toGo: Math.max(0, todayRow.target - todayRow.delivered) } : null,
    perDayFromTomorrow: afterToday > 0 ? Math.ceil(remaining / afterToday) : 0,
    days,
  }
}
