import type { OrderStatus } from "@/convex/rules"

export const taka = (n: number | undefined | null) =>
  `৳${Math.round(Number(n ?? 0)).toLocaleString("en-IN")}`

export const invoice = (n: number) => `BB-${n}`

const tz = "Asia/Dhaka"
export const dateTime = (t?: number) =>
  t ? new Date(t).toLocaleString("en-GB", { timeZone: tz, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: true }) : "—"
export const dateOnly = (t?: number) =>
  t ? new Date(t).toLocaleDateString("en-GB", { timeZone: tz, day: "2-digit", month: "short", year: "numeric" }) : "—"

export type Tone = "gray" | "amber" | "blue" | "violet" | "cyan" | "green" | "red" | "orange" | "pink" | "indigo" | "teal"

export const STATUS_TONE: Record<OrderStatus, Tone> = {
  pending: "amber",
  on_hold: "orange",
  approved: "blue",
  processing: "violet",
  pre_order: "pink",
  ready_to_ship: "indigo",
  in_transit: "cyan",
  delivered_due: "teal",
  delivered_paid: "green",
  pending_returned: "pink",
  returned: "red",
  damaged: "orange",
  cancelled: "gray",
}

export const TONE_CLASS: Record<Tone, string> = {
  gray: "bg-tone-gray-bg text-tone-gray",
  amber: "bg-tone-amber-bg text-tone-amber",
  blue: "bg-tone-blue-bg text-tone-blue",
  violet: "bg-tone-violet-bg text-tone-violet",
  cyan: "bg-tone-cyan-bg text-tone-cyan",
  green: "bg-tone-green-bg text-tone-green",
  red: "bg-tone-red-bg text-tone-red",
  orange: "bg-tone-orange-bg text-tone-orange",
  pink: "bg-tone-pink-bg text-tone-pink",
  indigo: "bg-tone-indigo-bg text-tone-indigo",
  teal: "bg-tone-teal-bg text-tone-teal",
}

/** Solid colours for active tabs / dots, per tone. */
export const TONE_SOLID: Record<Tone, string> = {
  gray: "bg-tone-gray text-white", amber: "bg-tone-amber text-white", blue: "bg-tone-blue text-white", violet: "bg-tone-violet text-white",
  cyan: "bg-tone-cyan text-white", green: "bg-tone-green text-white", red: "bg-tone-red text-white", orange: "bg-tone-orange text-white",
  pink: "bg-tone-pink text-white", indigo: "bg-tone-indigo text-white", teal: "bg-tone-teal text-white",
}

export const TAG_TONE: Record<string, Tone> = { NEW: "amber", REGULAR: "blue", VIP: "violet", RISKY: "red" }

export const errMsg = (e: unknown) => {
  const data = (e as { data?: unknown } | null)?.data
  if (typeof data === "string" && data) return data
  const raw = e instanceof Error ? e.message : String(e)
  // Convex wraps server errors: "[CONVEX M(...)] [Request ID: x] Server Error\nUncaught Error: msg\n  at ..."
  const m = raw.match(/Uncaught Error: ([^\n]+)/)
  return m ? m[1] : raw.replace(/^\[CONVEX[^\]]*\]\s*(\[Request ID[^\]]*\]\s*)?/, "")
}

export const telLink = (phone: string) => `tel:${phone}`
export const waLink = (phone: string) => `https://wa.me/88${phone}`

export function startOfDayBD(d = new Date()) {
  const bd = new Date(d.getTime() + 6 * 3600000)
  bd.setUTCHours(0, 0, 0, 0)
  return bd.getTime() - 6 * 3600000
}

/** Colour for each order-list tab (matches the status colours). */
export const TAB_TONE: Record<string, Tone> = {
  all: "gray", pending: "amber", on_hold: "orange", approved: "blue", processing: "violet", ready_to_ship: "indigo",
  in_transit: "cyan", delivered: "green", flagged: "red", cancelled: "gray",
}
