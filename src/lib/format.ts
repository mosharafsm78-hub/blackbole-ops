import type { OrderStatus } from "@/convex/rules"

export const taka = (n: number | undefined | null) =>
  `৳${Math.round(Number(n ?? 0)).toLocaleString("en-IN")}`

export const invoice = (n: number) => `BB-${n}`

const tz = "Asia/Dhaka"
export const dateTime = (t?: number) =>
  t ? new Date(t).toLocaleString("en-GB", { timeZone: tz, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: true }) : "—"
export const dateOnly = (t?: number) =>
  t ? new Date(t).toLocaleDateString("en-GB", { timeZone: tz, day: "2-digit", month: "short", year: "numeric" }) : "—"

export type Tone = "gray" | "amber" | "blue" | "violet" | "cyan" | "green" | "red" | "orange"

export const STATUS_TONE: Record<OrderStatus, Tone> = {
  pending: "amber",
  on_hold: "orange",
  approved: "blue",
  processing: "violet",
  ready_to_ship: "cyan",
  in_transit: "cyan",
  delivered_due: "green",
  delivered_paid: "green",
  pending_returned: "red",
  returned: "red",
  damaged: "red",
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
}

export const TAG_TONE: Record<string, Tone> = { NEW: "amber", REGULAR: "blue", VIP: "violet", RISKY: "red" }

export const errMsg = (e: unknown) => {
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
