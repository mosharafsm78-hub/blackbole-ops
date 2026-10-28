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
    permissions: ["dashboard.view", "orders.view", "orders.create", "orders.export", "customers.manage", "reports.view", "ads.view"],
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
      "inventory.receive", ...fulfilmentMoves.map(([f, t]) => moveKey(f, t)),
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

/** Post-return feedback call: confirming with the customer why the order actually came back, in their own
 *  words — separate from `reason`, which is just the category logged when the return was first raised and
 *  may have been set by whoever first saw the parcel coming back, not from talking to the customer. Reuses
 *  "Could not reach" as its own follow-up trigger, same as the delivery call. */
export const RETURN_CSAT_OUTCOMES = [
  "Confirmed — reason matches", "Changed mind — wants to keep it", "Unhappy — product issue", "Unhappy — service issue", "Could not reach", "Declined to answer",
]

/** A `reason` value written by an automatic sync (a Pathao status string, a Nuport migration placeholder) is
 *  not a real, customer-given reason — it's just what the system happened to be told at the time. Treat it as
 *  if no reason were recorded so the UI keeps asking a human to actually call and log one, instead of quietly
 *  showing junk text as if the work were done. */
const SYSTEM_REASON_RE = /^(Same as Nuport|Pathao:)/i
export function isRealReason(reason?: string | null): boolean {
  return !!reason && !SYSTEM_REASON_RE.test(reason)
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
