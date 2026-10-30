// Shared business rules. Imported by Convex functions AND the React UI,
// so keep this file free of server-only imports.

export type OrderStatus =
  | "pending"
  | "on_hold"
  | "approved"
  | "processing"
  | "pre_order"
  | "pre_order_bd"
  | "ready_to_ship"
  | "in_transit"
  | "delivered_due"
  | "delivered_paid"
  | "pending_returned"
  | "returned"
  | "damaged"
  | "cancelled"

export const STATUS_LABEL: Record<OrderStatus, string> = {
  pending: "Pending",
  on_hold: "On Hold",
  approved: "Approved",
  processing: "Processing",
  pre_order: "Pre-Order · China",
  pre_order_bd: "Pre-Order · Bangladesh",
  ready_to_ship: "Ready To Ship",
  in_transit: "In Transit",
  delivered_due: "Delivered · Payment Due",
  delivered_paid: "Delivered · Paid",
  pending_returned: "Pending Return",
  returned: "Returned",
  damaged: "Damaged",
  cancelled: "Cancelled",
}

export const ALL_STATUSES = Object.keys(STATUS_LABEL) as OrderStatus[]

// Tabs on the order list. Delivered and Flagged group several statuses.
export const STATUS_TABS: { key: string; label: string; statuses: OrderStatus[] }[] = [
  { key: "pending", label: "Pending", statuses: ["pending"] },
  { key: "on_hold", label: "On Hold", statuses: ["on_hold"] },
  { key: "approved", label: "Approved", statuses: ["approved"] },
  { key: "processing", label: "Processing", statuses: ["processing"] },
  { key: "pre_order", label: "Pre-Order", statuses: ["pre_order", "pre_order_bd"] },
  { key: "ready_to_ship", label: "Ready To Ship", statuses: ["ready_to_ship"] },
  { key: "in_transit", label: "In Transit", statuses: ["in_transit"] },
  { key: "delivered", label: "Delivered", statuses: ["delivered_due", "delivered_paid"] },
  { key: "flagged", label: "Flagged", statuses: ["pending_returned", "returned", "damaged"] },
  { key: "cancelled", label: "Cancelled", statuses: ["cancelled"] },
]

/** Sub-tabs of the Exchange tab. */
export const EXCHANGE_SUBS: { key: string; label: string; statuses: OrderStatus[] }[] = [
  { key: "open", label: "Not sent yet", statuses: ["pending", "on_hold", "approved", "processing", "pre_order", "pre_order_bd", "ready_to_ship"] },
  { key: "in_transit", label: "In Transit", statuses: ["in_transit"] },
  { key: "delivered", label: "Delivered", statuses: ["delivered_due", "delivered_paid"] },
  { key: "returned", label: "Returned", statuses: ["pending_returned", "returned", "damaged"] },
  { key: "cancelled", label: "Cancelled", statuses: ["cancelled"] },
]

// Every move the system allows (mirrors the workflow BlackBole already uses).
export const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending: ["approved", "on_hold", "cancelled"],
  on_hold: ["approved", "pending", "cancelled"],
  approved: ["processing", "pre_order", "pre_order_bd", "ready_to_ship", "in_transit", "delivered_due", "delivered_paid", "pending", "on_hold", "cancelled"],
  processing: ["ready_to_ship", "pre_order", "pre_order_bd", "in_transit", "delivered_due", "delivered_paid", "approved", "on_hold", "cancelled"],
  pre_order: ["processing", "ready_to_ship", "in_transit", "pre_order_bd", "approved", "on_hold", "cancelled"],
  pre_order_bd: ["processing", "ready_to_ship", "in_transit", "pre_order", "approved", "on_hold", "cancelled"],
  ready_to_ship: ["in_transit", "processing", "pre_order", "pre_order_bd", "on_hold"],
  in_transit: ["delivered_due", "delivered_paid", "pending_returned", "returned", "processing", "approved", "ready_to_ship", "cancelled"],
  delivered_due: ["delivered_paid", "pending_returned", "returned"],
  delivered_paid: ["pending_returned", "returned"],
  pending_returned: ["returned", "damaged"],
  returned: ["damaged"],
  damaged: [],
  cancelled: ["pending"],
}

// Pre-order products take weeks to arrive. A variant is pre-order when its SKU starts with "PO-"
// (how Shopify and Nuport name them) or its product is switched to pre-order.
export type PreOrderFrom = "china" | "bangladesh"
export const PRE_ORDER_STATUS: Record<PreOrderFrom, OrderStatus> = { china: "pre_order", bangladesh: "pre_order_bd" }
export const isPreOrderStatus = (s: string) => s === "pre_order" || s === "pre_order_bd"
export const isPreOrderSku = (sku?: string | null) => !!sku && /^PO-/i.test(sku.trim())

export function canTransition(from: OrderStatus, to: OrderStatus) {
  return TRANSITIONS[from].includes(to)
}

// Where the units of an order sit in stock for each status.
export type Bucket = "available" | "processing" | "inTransit" | "returning" | "damaged" | "sold"

/** Orders that still owe us stock: raised but not yet shipped. This is the "Committed" figure the
 *  Operations Director asked for — Pending, On Hold, Approved, Processing, Pre-Order (both origins) and
 *  Ready To Ship. Deliberately NOT derived from the `stock.processing` bucket: Pending and On Hold sit in
 *  `available` (STATUS_BUCKET), so the bucket alone would under-count committed units by every unapproved
 *  order. Cancelled / returned / delivered are excluded — they no longer owe us anything. */
export const COMMITTED_STATUSES: OrderStatus[] = [
  "pending",
  "on_hold",
  "approved",
  "processing",
  "pre_order",
  "pre_order_bd",
  "ready_to_ship",
]

/** Units the courier is bringing BACK to the warehouse — inventory that is arriving soon, so the
 *  fulfillment team must see it. `pending_returned` is the only status in the `returning` bucket.
 *
 *  `returned` is deliberately EXCLUDED: a returned item has already landed and rolled back into regular
 *  Available stock (STATUS_BUCKET maps `returned` → `available`), so counting it here would double-count
 *  the same pair of shoes. Same for `damaged`, which is its own bucket and never sellable. */
export const RETURNING_STATUSES: OrderStatus[] = ["pending_returned"]
export const STATUS_BUCKET: Record<OrderStatus, Bucket> = {
  pending: "available",
  on_hold: "available",
  cancelled: "available",
  approved: "processing",
  processing: "processing",
  pre_order: "processing",
  pre_order_bd: "processing",
  ready_to_ship: "processing",
  in_transit: "inTransit",
  delivered_due: "sold",
  delivered_paid: "sold",
  pending_returned: "returning",
  returned: "available",
  damaged: "damaged",
}

// ---------- Permissions ----------
export const PERMISSIONS: { key: string; label: string; group: string }[] = [
  { key: "dashboard.view", label: "View dashboard", group: "General" },
  { key: "orders.view", label: "View orders", group: "Orders" },
  { key: "orders.create", label: "Create orders", group: "Orders" },
  { key: "orders.edit", label: "Edit orders (items, address, fees)", group: "Orders" },
  { key: "orders.print", label: "Print invoices", group: "Orders" },
  { key: "orders.export", label: "Export orders", group: "Orders" },
  { key: "orders.payments", label: "Add payments", group: "Orders" },
  { key: "courier.book", label: "Book / retry courier", group: "Orders" },
  { key: "customers.manage", label: "Manage customers", group: "Customers" },
  { key: "products.manage", label: "Manage products & prices", group: "Products" },
  { key: "inventory.receive", label: "Receive stock (product in)", group: "Inventory" },
  { key: "inventory.adjust", label: "Adjust stock", group: "Inventory" },
  { key: "purchases.manage", label: "Create purchase orders & suppliers", group: "Inventory" },
  { key: "purchases.pay", label: "Record supplier payments", group: "Inventory" },
  { key: "orders.upload", label: "Upload orders (CSV)", group: "Orders" },
  { key: "orders.delete", label: "Delete / restore orders", group: "Orders" },
  { key: "orders.costs", label: "View & edit order costs", group: "Orders" },
  { key: "orders.accountability", label: "Respond to accountability flags", group: "Orders" },
  { key: "partners.manage", label: "Manage delivery partners", group: "Delivery" },
  { key: "accounting.view", label: "View accounting", group: "Accounting" },
  { key: "expenses.request", label: "Request expenses", group: "Accounting" },
  { key: "expenses.approve", label: "Approve / pay expenses", group: "Accounting" },
  { key: "reports.view", label: "Create & view reports", group: "Reports" },
  { key: "ads.view", label: "View ads analytics", group: "Reports" },
  { key: "website.manage", label: "Manage website products & collections", group: "Website" },
  { key: "settings.manage", label: "Manage settings & integrations", group: "Admin" },
  { key: "team.manage", label: "Manage team & roles", group: "Admin" },
]

export const moveKey = (from: OrderStatus, to: OrderStatus) => `move:${from}>${to}`

export const ALL_MOVE_KEYS = ALL_STATUSES.flatMap((f) => TRANSITIONS[f].map((t) => moveKey(f, t)))

export function hasPerm(perms: string[], key: string) {
  return perms.includes("*") || perms.includes(key)
}

const cxMoves: [OrderStatus, OrderStatus][] = [
  ["pending", "approved"], ["pending", "on_hold"], ["pending", "cancelled"],
  ["on_hold", "approved"], ["on_hold", "pending"], ["on_hold", "cancelled"],
  ["approved", "pending"], ["approved", "on_hold"], ["approved", "cancelled"],
  ["cancelled", "pending"],
]
const fulfilmentMoves: [OrderStatus, OrderStatus][] = ALL_STATUSES.flatMap((f) =>
  TRANSITIONS[f].map((t) => [f, t] as [OrderStatus, OrderStatus]),
).filter(([f]) => !["pending", "on_hold", "cancelled"].includes(f))

export const DEFAULT_ROLES: { name: string; permissions: string[] }[] = [
  { name: "Super Admin", permissions: ["*"] },
  {
    name: "Sales & Marketing",
    permissions: ["dashboard.view", "orders.view", "orders.create", "orders.export", "customers.manage", "reports.view", "ads.view", "orders.accountability"],
  },
  {
    name: "Procurement & Sourcing",
    permissions: ["orders.view", "products.manage", "inventory.receive", "inventory.adjust", "purchases.manage", "purchases.pay", "reports.view", "expenses.request"],
  },
  {
    name: "Team CX",
    permissions: [
      "dashboard.view", "orders.view", "orders.create", "orders.edit", "orders.print",
      "customers.manage", ...cxMoves.map(([f, t]) => moveKey(f, t)),
    ],
  },
  {
    name: "Fulfillment",
    permissions: [
      "dashboard.view", "orders.view", "orders.print", "orders.payments", "courier.book",
      "inventory.receive", "orders.accountability", ...fulfilmentMoves.map(([f, t]) => moveKey(f, t)),
    ],
  },
  {
    name: "Asst. O. of Fulfillment & Inventory",
    permissions: ["orders.view", "products.manage", "inventory.receive", "inventory.adjust", "purchases.manage"],
  },
]

export const ORDER_SOURCES = [
  "Facebook", "Website", "Phone Call", "Offline", "Other", "Up Sell",
  "Messenger", "WhatsApp", "TikTok", "Instagram", "Live Chat", "Telesales",
]

export const PAYMENT_METHODS = [
  "Cash On Delivery", "Cash", "Cheque", "Card", "Net Banking", "bKash", "Rocket", "Nagad", "Upay", "Tap", "SSLCommerz",
]

export const SMS_STATUSES: OrderStatus[] = ["pending", "approved", "ready_to_ship", "in_transit", "delivered_paid", "cancelled"]

// Outgoing webhook events (same set as Nuport)
export const WEBHOOK_EVENTS: { key: string; label: string; group: string }[] = [
  { key: "order.pending", label: "Pending", group: "Order" },
  { key: "order.on_hold", label: "On hold", group: "Order" },
  { key: "order.approved", label: "Approved", group: "Order" },
  { key: "order.processing", label: "Processing", group: "Order" },
  { key: "order.pre_order", label: "Pre-Order", group: "Order" },
  { key: "order.ready_to_ship", label: "Ready to ship", group: "Order" },
  { key: "order.in_transit", label: "In transit", group: "Order" },
  { key: "order.delivered.payment_due", label: "Delivered · payment due", group: "Order" },
  { key: "order.delivered.payment_collected", label: "Delivered · payment collected", group: "Order" },
  { key: "order.flagged.pending_returned", label: "Pending returned", group: "Order" },
  { key: "order.flagged.returned", label: "Returned", group: "Order" },
  { key: "order.flagged.damaged", label: "Damaged", group: "Order" },
  { key: "order.cancelled", label: "Cancelled", group: "Order" },
  { key: "product.created", label: "Product created", group: "Product" },
  { key: "product.updated", label: "Product updated", group: "Product" },
  { key: "inventory.updated", label: "Stock changed", group: "Inventory" },
]

export const STATUS_EVENT: Record<OrderStatus, string> = {
  pending: "order.pending", on_hold: "order.on_hold", approved: "order.approved", processing: "order.processing", pre_order: "order.pre_order", pre_order_bd: "order.pre_order",
  ready_to_ship: "order.ready_to_ship", in_transit: "order.in_transit", delivered_due: "order.delivered.payment_due",
  delivered_paid: "order.delivered.payment_collected", pending_returned: "order.flagged.pending_returned",
  returned: "order.flagged.returned", damaged: "order.flagged.damaged", cancelled: "order.cancelled",
}

export const EXPENSE_HEADS = [
  "Rent", "Salary", "Utilities", "Marketing / Ads", "Packaging", "Transport", "Courier", "Office supplies", "Repairs", "Food & entertainment", "Other",
]

export const CALL_OUTCOMES = [
  "Confirmed", "Confirmed by message", "Will confirm later", "No answer", "Busy / call later", "Switched off", "Wrong number", "Customer cancelled", "Changed order",
]

/** Where a customer confirmed by message (WhatsApp / Facebook Messenger / Instagram). */
export const MESSAGE_CHANNELS = ["WhatsApp", "Messenger", "Instagram"]

/** Outcomes that need another call — the dialog asks when to follow up. */
export const FOLLOW_UP_OUTCOMES = ["Will confirm later", "Busy / call later", "No answer", "Switched off"]

/** Post-delivery feedback call: how did the experience actually go — separate from the pre-delivery
 *  confirmation call, so it can be counted on its own (real CSAT data, not folded into call outcomes). */
export const CSAT_OUTCOMES = [
  "Happy — no issues", "Happy — minor issue", "Unhappy — product issue", "Unhappy — delivery issue", "Unhappy — other", "Could not reach", "Declined to answer",
]

/** Outcomes that need another feedback-call attempt — mirrors FOLLOW_UP_OUTCOMES for the pre-delivery call. */
export const CSAT_FOLLOWUP_OUTCOMES = ["Could not reach"]

// Standardized so these roll up into real numbers later (e.g. Action Center breaking down returns by cause) —
// a typed-out reason can never be counted, a picked one always can. Shared by the "Edit reason" category chips
// and the Return feedback call outcomes below, so a customer's actual return reason is the same vocabulary
// whether it was picked when the return was first raised or confirmed later on a call.
export const RETURN_REASONS = ["Wrong size sent", "Wrong product sent", "Damaged / defective", "Doesn't match description", "Customer changed mind", "Size didn't fit", "Late delivery", "Other"]

/** Post-return feedback call: confirming with the customer the actual reason the order came back — same
 *  category list as the return reason itself (RETURN_REASONS), not a separate made-up set of outcomes, plus
 *  the two call-status options every feedback call needs. "Could not reach" is its own follow-up trigger,
 *  same as the delivery call. */
export const RETURN_CSAT_OUTCOMES = [...RETURN_REASONS, "Could not reach", "Declined to answer"]

/** Of the return reasons, these are BlackBole's own doing — the wrong item, a damaged item, a late delivery,
 *  a listing that didn't match — rather than the customer's own call (changed mind, size didn't fit). These
 *  are the ones worth a recovery attempt: a mistake we can still make right. */
export const RETURN_AT_FAULT_REASONS = ["Wrong size sent", "Wrong product sent", "Damaged / defective", "Doesn't match description", "Late delivery"]

/** Accountability: once a return call confirms it was really our own fault, the one department that actually
 *  caused it gets a flag it has to answer — inside this system, not a side chat. Picking/packing mistakes go to
 *  Fulfillment, a wrong listing goes to Marketing, and so on — this is where that routing lives, so every at-fault
 *  reason has exactly one owning department and nothing falls through the cracks.
 *
 *  Customer Care's own counterweight — before these, CX had no way to lose a single point, no matter how badly
 *  a call went, since nothing here ever routed to "Customer Care". "Fake / prank order" / "Duplicate order" fire
 *  from orders.ts only when the order had already been confirmed (approved) by a CX call — catching one of
 *  these BEFORE confirming it is CX doing its job right, not a miss. "Confirmation call overdue" / "Feedback
 *  call overdue" / "Return call overdue" fire from accountability.ts's daily checks when the required call
 *  hasn't been logged inside its own SLA window.
 *
 *  "Customer changed mind" / "Size didn't fit" / "Other" are deliberately NOT in RETURN_AT_FAULT_REASONS above —
 *  nobody made a packing or listing mistake. They route here anyway, by elimination: the one CX call that's
 *  supposed to screen for a genuine, well-understood order still ended in a return, and no other department
 *  caused it, so the outcome sits with whoever ran that call — a screening-effectiveness signal, not a claim
 *  that CX did anything wrong on the call itself. */
export const ACCOUNTABILITY_ROUTING: Record<string, string> = {
  "Wrong product sent": "Fulfillment",
  "Wrong size sent": "Fulfillment",
  "Damaged / defective": "Fulfillment",
  "Late delivery": "Fulfillment",
  "Doesn't match description": "Marketing",
  "Customer changed mind": "Customer Care",
  "Size didn't fit": "Customer Care",
  "Other": "Customer Care",
  "Fake / prank order": "Customer Care",
  "Duplicate order": "Customer Care",
  "Confirmation call overdue": "Customer Care",
  "Feedback call overdue": "Customer Care",
  "Return call overdue": "Customer Care",
  "Hold overdue": "Customer Care",
  "Dispatch overdue": "Fulfillment",
  "Delivery attempt failed": "Fulfillment",
}

/** True for any call outcome worth flagging red — an unhappy delivery, or a return whose reason was our own
 *  fault — so a real problem stands out in the timeline instead of blending in with routine calls. */
export function isNegativeOutcome(outcome?: string | null): boolean {
  return !!outcome && (outcome.startsWith("Unhappy") || RETURN_AT_FAULT_REASONS.includes(outcome))
}

/** Recovery call: after a return that was our own fault, CX reaches back out, makes it right, and tries to
 *  win the customer back with a fresh order — this time fulfilling what they actually wanted. Its own field
 *  (`recovery`), separate from `returnCsat`, with the same mandatory-note + Super-Admin-lock rules as every
 *  other feedback call. */
export const RECOVERY_OUTCOMES = ["Recovered — placed a new order", "Offered — declined", "Could not reach", "Declined to answer"]

/** A `reason` value written by an automatic sync (a Pathao status string, a Nuport migration placeholder) is
 *  not a real, customer-given reason — it's just what the system happened to be told at the time. Treat it as
 *  if no reason were recorded so the UI keeps asking a human to actually call and log one, instead of quietly
 *  showing junk text as if the work were done. */
const SYSTEM_REASON_RE = /^(Same as Nuport|Pathao:)/i
export function isRealReason(reason?: string | null): boolean {
  return !!reason && !SYSTEM_REASON_RE.test(reason)
}

// ---------------- Advance-payment reasons (Hold / Cancel) ----------------
// Three exact reasons, kept here (not in the modal) because BOTH the form and the mutation have to agree on
// them: the modal decides whether to reveal the amount/date inputs, and the mutation decides whether to
// accept and store them. One list, one truth.
export const ADVANCE_REASON_AWAITING = "Hold: Awaiting Advance Payment"
export const ADVANCE_REASON_PROMISED = "Hold: Customer Promised Advance"
export const ADVANCE_REASON_REFUSED = "Canceled: Refused Advance Payment"
// An advance that was asked for and then never came. Distinct from "refused" (the customer said no) because
// the follow-up differs: a refusal is final, an expiry is a cart worth one more chase.
export const ADVANCE_REASON_FAILED = "Canceled: Advance Payment Failed/Expired"

export const ADVANCE_REASONS = [
  ADVANCE_REASON_AWAITING, ADVANCE_REASON_PROMISED, ADVANCE_REASON_REFUSED, ADVANCE_REASON_FAILED,
]

/**
 * Machine-readable code stored on the order alongside the human reason.
 *
 * Both cancel chips map to the SAME code, "refused_advance", because `cancelReason` is a coarse bucket —
 * "this order died because of the advance payment" — while `reason` keeps the precise wording ("refused" vs
 * "failed/expired"). That way every advance-driven cancel is found with one query, and the nuance is still on
 * the record for anyone reading the order itself.
 *
 * Deliberately only the CANCEL reasons get a code: `cancelReason` answers "why did this order die", and a
 * hold is not a death. Hold reasons keep their advance data but no cancel code.
 */
export const ADVANCE_CANCEL_CODES: Record<string, string> = {
  [ADVANCE_REASON_REFUSED]: "refused_advance",
  [ADVANCE_REASON_FAILED]: "refused_advance",
}

/** The code for a cancel-type advance reason, or undefined when the reason isn't one. */
export function advanceReasonCode(reason?: string | null): string | undefined {
  return reason ? ADVANCE_CANCEL_CODES[reason] : undefined
}

/** True only for the two reasons that cancel an order because of the advance. */
export function isAdvanceCancelReason(reason?: string | null): boolean {
  return !!advanceReasonCode(reason)
}

/** Does picking this reason mean the order is parked on an advance payment? Drives the extra two inputs. */
export function isAdvanceReason(reason?: string | null): boolean {
  return !!reason && ADVANCE_REASONS.includes(reason)
}

/** The whole advance-payment block for a given reason. */
export type AdvanceFields = { expectedAdvanceAmount?: number; promisedPaymentDate?: number }

/**
 * What the two advance inputs should hold after an agent picks a new reason.
 *
 * This is the form-side half of the stale-data fix: the caller REPLACES its two inputs with the returned
 * pair rather than patching them, so nothing typed under a previous reason can survive into a different one.
 * Re-picking the same reason keeps what's already there (an agent correcting a typo shouldn't lose the date).
 */
export function resolveReasonToggle(input: { from?: string | null; to: string; amount: string; date: string }) {
  const staying = input.from === input.to
  return staying ? { amount: input.amount, date: input.date } : { amount: "", date: "" }
}

/** Ordinary reason chips for a move — the shared vocabulary behind the Hold/Cancel/Return pickers. */
export const CANCEL_REASONS = ["Customer cancelled", "Fake / prank order", "Duplicate order", "Out of stock", "Unreachable after 3 calls", "Price issue", "Other"]
export const HOLD_REASONS = ["Customer asked to ship on a date", "Customer asked to wait", "Stock not ready", "Address unclear", "Other"]

/**
 * Reason chips for a status. The advance-payment reasons come FIRST on Hold and Cancel so they read as one
 * clear group, and each is shown exactly as it will be stored — the "Hold:"/"Canceled:" prefix included —
 * so a record can never say a bare "Advance payment pending" that reads like any other hold.
 *
 * Cancel offers all four (an advance can be asked for, promised, refused, or simply never arrive); Hold
 * offers only the two that make sense while the order is still alive. Return moves keep their own
 * vocabulary and never get an advance chip.
 */
export function reasonPresets(status?: OrderStatus | null): string[] {
  if (status === "on_hold") return [ADVANCE_REASON_AWAITING, ADVANCE_REASON_PROMISED, ...HOLD_REASONS]
  if (status === "cancelled") return [ADVANCE_REASON_REFUSED, ADVANCE_REASON_FAILED, ...CANCEL_REASONS]
  if (status === "returned" || status === "pending_returned" || status === "damaged") return RETURN_REASONS
  return []
}

/** Amount as typed by an agent ("5,000", " 5000 ", "৳5000") → a whole taka number, or null if unusable. */
export function parseTakaInput(raw?: string | number | null): number | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw === "number") return Number.isFinite(raw) && raw >= 0 ? Math.round(raw) : null
  const cleaned = raw.replace(/[^0-9.]/g, "")
  if (!cleaned || cleaned === ".") return null
  const n = Number(cleaned)
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null
}

/** A `<input type="date">` value ("2026-11-05") → UTC start-of-day epoch ms, or null if not a real date.
 *  Deliberately UTC, not the executing process's local time: this same function runs both in the browser (the
 *  staff member's own local timezone) and in Convex (the server's, whatever that happens to be) — using local
 *  time would make the stored ms depend on which side computed it, and silently shift the calendar date by a
 *  day whenever that's read back with a UTC-based formatter (as the order-timeline text does). */
export function dateInputToMs(value?: string | null): number | null {
  if (!value) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (!m) return null
  const [, y, mo, d] = m
  const year = Number(y), month = Number(mo), day = Number(d)
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const ms = Date.UTC(year, month - 1, day)
  // rejects 2026-02-31, which Date would silently roll into March
  const back = new Date(ms)
  if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) return null
  return ms
}

/** Epoch ms → "YYYY-MM-DD" for the date input, or "" when unset. */
export function msToDateInput(ms?: number | null): string {
  if (!ms || !Number.isFinite(ms)) return ""
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * Validates + normalises the advance block for a status change.
 * Returns `{ ok: true, fields }` (fields empty when the reason is ordinary) or `{ ok: false, error }`.
 * The mutation calls this so a bad amount can never be stored, whatever the UI does.
 */
export function buildAdvanceFields(input: {
  reason?: string | null
  expectedAdvanceAmount?: number | null
  promisedPaymentDate?: number | null
}): { ok: true; fields: AdvanceFields } | { ok: false; error: string } {
  if (!isAdvanceReason(input.reason)) return { ok: true, fields: {} }
  const amount = input.expectedAdvanceAmount
  if (amount === undefined || amount === null) return { ok: false, error: "Enter the expected advance amount." }
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: "The advance amount must be more than ৳0." }
  const date = input.promisedPaymentDate
  if (date === undefined || date === null || !Number.isFinite(date)) return { ok: false, error: "Pick the date the advance was promised for." }
  return { ok: true, fields: { expectedAdvanceAmount: Math.round(amount), promisedPaymentDate: date } }
}

export const CUSTOMER_TAGS = ["NEW", "REGULAR", "VIP", "RISKY"]

// Bangladesh phone → 01XXXXXXXXX
export function normalizePhone(raw: string): string {
  const digits = (raw || "").replace(/\D/g, "")
  if (digits.startsWith("880")) return "0" + digits.slice(3)
  if (digits.startsWith("88") && digits.length === 13) return digits.slice(2)
  if (digits.length === 10 && digits.startsWith("1")) return "0" + digits
  return digits
}

export function orderTotals(items: { price: number; qty: number; discount: number }[], discount: number, deliveryFee: number, paid: number) {
  const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0)
  const itemDiscount = items.reduce((s, i) => s + i.discount, 0)
  const total = Math.max(0, subtotal - itemDiscount - discount + deliveryFee)
  return { subtotal, total, due: Math.max(0, total - paid) }
}

export const PO_STATUS_LABEL: Record<string, string> = {
  draft: "Draft", ordered: "Ordered", shipped: "On the way", partial: "Partly received", received: "Received", cancelled: "Cancelled",
}

export const SUPPLIER_PAY_METHODS = ["Cash", "Bank transfer", "bKash", "Nagad", "Rocket", "Cheque", "Other"]

/** SKU in BlackBole style: BB-SH-HSS-BLACK-41 */
export function makeSku(prefix: string, model: string, color: string, size: string) {
  const clean = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, "")
  return [prefix.toUpperCase().replace(/[^A-Z0-9-]+/g, ""), clean(model), clean(color), clean(size)].filter(Boolean).join("-").replace(/-+/g, "-")
}

/** Initials of a model name: "Harbor Shore Sandal" -> "HSS" */
export function modelCode(name: string) {
  const words = name.replace(/blackbole/gi, "").split(/\s+/).filter((w) => w && !/^(for|and|the|men|women|kids|unisex|-)$/i.test(w))
  return words.map((w) => w[0]).join("").toUpperCase().slice(0, 5)
}

export const CATEGORY_CODES: Record<string, string> = {
  Sandals: "SH", Shoes: "SH", Sneakers: "SH", Loafers: "SH", Boots: "SH", "Hiking Shoes": "SH", "Kids Shoes": "SH",
  Dresses: "DRESS", "T-Shirts": "TS", Shirts: "SHIRT", Pants: "PANT", Bags: "BAG", Accessories: "ACC",
}
