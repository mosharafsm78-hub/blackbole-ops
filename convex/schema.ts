import { defineSchema, defineTable } from "convex/server"
import { v } from "convex/values"
import { authTables } from "@convex-dev/auth/server"

export const orderStatus = v.union(
  v.literal("pending"),
  v.literal("on_hold"),
  v.literal("approved"),
  v.literal("processing"),
  v.literal("pre_order"),
  v.literal("pre_order_bd"),
  v.literal("ready_to_ship"),
  v.literal("in_transit"),
  v.literal("delivered_due"),
  v.literal("delivered_paid"),
  v.literal("pending_returned"),
  v.literal("returned"),
  v.literal("damaged"),
  v.literal("cancelled"),
)

export const orderItem = v.object({
  variantId: v.optional(v.id("variants")),
  sku: v.string(),
  name: v.string(),
  attrs: v.optional(v.string()),
  imageUrl: v.optional(v.string()),
  price: v.number(),
  qty: v.number(),
  discount: v.number(),
  weightKg: v.number(),
})

export default defineSchema({
  ...authTables,

  // Team members allowed into the app. Linked to an auth user on first sign-in.
  staff: defineTable({
    email: v.string(),
    name: v.string(),
    phone: v.optional(v.string()),
    roleId: v.id("roles"),
    userId: v.optional(v.id("users")),
    active: v.boolean(),
    createdAt: v.number(),
    // per-person switches on top of the role
    extraPerms: v.optional(v.array(v.string())),
    deniedPerms: v.optional(v.array(v.string())),
  })
    .index("by_email", ["email"])
    .index("by_user", ["userId"]),

  // People who signed up but aren't on the team yet — an admin approves them
  accessRequests: defineTable({
    userId: v.id("users"),
    email: v.string(),
    name: v.optional(v.string()),
    status: v.string(), // waiting | rejected
    at: v.number(),
  }).index("by_user", ["userId"]),


  roles: defineTable({
    name: v.string(),
    permissions: v.array(v.string()),
    system: v.optional(v.boolean()),
  }),

  locations: defineTable({
    name: v.string(),
    address: v.optional(v.string()),
    phone: v.optional(v.string()),
    pathaoStoreId: v.optional(v.number()),
    isDefault: v.optional(v.boolean()),
    active: v.boolean(),
    // Exchange warehouse: internal stock + exchange parcels only — orders here are NEVER sent to Pathao
    noCourier: v.optional(v.boolean()),
    shopifyLocationId: v.optional(v.string()), // received stock here is also added to this Shopify location
  }),

  products: defineTable({
    name: v.string(),
    category: v.optional(v.string()),
    description: v.optional(v.string()),
    // Bulleted product features shown on the internal product page (Nuport-style). Additive + optional,
    // so existing product rows are untouched and nothing that reads `products` breaks.
    features: v.optional(v.array(v.string())),
    imageUrl: v.optional(v.string()),
    active: v.boolean(),
    preOrder: v.optional(v.boolean()), // takes long to arrive; orders with it go to the Pre-Order tab
    preOrderFrom: v.optional(v.union(v.literal("china"), v.literal("bangladesh"))), // where it comes from (default China)
    createdAt: v.number(),
    deletedAt: v.optional(v.number()),
    // Website (blackbole.com): URL handle + everything the site shows (see convex/website.ts). Optional.
    handle: v.optional(v.string()),
    web: v.optional(v.any()),
  })
    .searchIndex("search_name", { searchField: "name" })
    .index("by_handle", ["handle"]),

  variants: defineTable({
    productId: v.id("products"),
    sku: v.string(),
    title: v.string(), // e.g. "Black / 42"
    attrs: v.optional(v.string()),
    weightKg: v.number(),
    price: v.number(), // selling price (MRP)
    purchasePrice: v.number(),
    distributorPrice: v.optional(v.number()),
    retailerPrice: v.optional(v.number()),
    imageUrl: v.optional(v.string()),
    active: v.boolean(),
    createdAt: v.optional(v.number()),
    shopifyItemId: v.optional(v.string()), // Shopify inventory item (cached for the stock sync)
    web: v.optional(v.any()), // website: { id, compareAt, options, image, parent? } (see convex/website.ts)
  })
    .index("by_sku", ["sku"])
    .index("by_product", ["productId"]),

  stock: defineTable({
    variantId: v.id("variants"),
    locationId: v.id("locations"),
    available: v.number(),
    processing: v.number(),
    inTransit: v.number(),
    returning: v.number(),
    damaged: v.number(),
    wastage: v.optional(v.number()),
    expired: v.optional(v.number()),
  })
    .index("by_variant_location", ["variantId", "locationId"])
    .index("by_location", ["locationId"])
    .index("by_variant", ["variantId"]),

  stockLogs: defineTable({
    variantId: v.id("variants"),
    locationId: v.id("locations"),
    bucket: v.string(),
    change: v.number(),
    reason: v.string(),
    orderId: v.optional(v.id("orders")),
    receiptId: v.optional(v.id("receipts")),
    note: v.optional(v.string()),
    byName: v.string(),
    at: v.number(),
  })
    .index("by_variant", ["variantId", "at"])
    .index("by_location", ["locationId", "at"])
    .index("by_at", ["at"]),

  // Factories / suppliers we buy from
  suppliers: defineTable({
    name: v.string(),
    contactPerson: v.optional(v.string()),
    phone: v.optional(v.string()),
    email: v.optional(v.string()),
    address: v.optional(v.string()),
    note: v.optional(v.string()),
    openingDue: v.optional(v.number()), // what we owed before using this system
    active: v.boolean(),
    createdAt: v.number(),
  }),

  // Purchase orders: what we ordered from a supplier, received in one or more GRNs
  purchaseOrders: defineTable({
    code: v.number(), // PO-0001
    supplierId: v.optional(v.id("suppliers")),
    supplierName: v.string(),
    locationId: v.id("locations"),
    status: v.string(), // draft | ordered | shipped | partial | received | cancelled
    shippedAt: v.optional(v.number()),
    tracking: v.optional(v.string()), // freight forwarder / tracking no.
    supplierRef: v.optional(v.string()), // supplier's invoice / challan no.
    orderedAt: v.optional(v.number()),
    expectedAt: v.optional(v.number()),
    items: v.array(v.object({
      variantId: v.id("variants"),
      sku: v.string(),
      name: v.string(),
      title: v.string(),
      orderedQty: v.number(),
      receivedQty: v.number(),
      damagedQty: v.number(),
      unitCost: v.number(),
    })),
    subtotal: v.number(),
    discount: v.number(),
    shippingCost: v.number(),
    otherCost: v.number(),
    total: v.number(),
    paid: v.number(),
    due: v.number(),
    note: v.optional(v.string()),
    files: v.array(v.object({ storageId: v.id("_storage"), name: v.string(), type: v.string(), at: v.number() })),
    createdBy: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
    receivedAt: v.optional(v.number()),
  })
    .index("by_created", ["createdAt"])
    .index("by_supplier", ["supplierId", "createdAt"]),

  supplierPayments: defineTable({
    poId: v.optional(v.id("purchaseOrders")),
    supplierId: v.optional(v.id("suppliers")),
    amount: v.number(),
    method: v.string(),
    reference: v.optional(v.string()),
    note: v.optional(v.string()),
    slipId: v.optional(v.id("_storage")), // bank slip / bKash screenshot / receipt
    slipName: v.optional(v.string()),
    byName: v.string(),
    at: v.number(),
  })
    .index("by_po", ["poId"])
    .index("by_supplier", ["supplierId"]),

  // "Product goes back out" — goods we received that turn out damaged/wrong/expired and get physically sent
  // back to the supplier. The mirror image of receipts: stock leaves a bucket (usually Damaged, sometimes
  // Available if it was never actually usable) the moment this is created, because the goods are no longer
  // in the warehouse — resolving it later (refund/credit/replacement/rejected) is a separate, paperwork step
  // that never re-touches stock.
  supplierReturns: defineTable({
    code: v.number(), // SR-0001
    supplierId: v.id("suppliers"),
    supplierName: v.string(),
    locationId: v.id("locations"),
    poId: v.optional(v.id("purchaseOrders")), // which purchase these goods originally came in on, if known
    items: v.array(v.object({
      variantId: v.id("variants"),
      sku: v.string(),
      name: v.string(),
      title: v.string(),
      qty: v.number(),
      unitCost: v.number(),
      bucket: v.string(), // which stock bucket this came out of — "damaged" or "available"
    })),
    totalValue: v.number(),
    reason: v.string(), // why it's going back: not in good condition, wrong item sent, expired, etc.
    note: v.optional(v.string()),
    status: v.string(), // "pending" (created, not yet sent) | "sent" (physically on its way back) | "resolved"
    sentAt: v.optional(v.number()),
    resolution: v.optional(v.string()), // "refunded" | "credited" | "replaced" | "rejected"
    resolutionNote: v.optional(v.string()),
    creditedAmount: v.optional(v.number()), // taka actually credited against what we owe this supplier, if any
    resolvedAt: v.optional(v.number()),
    resolvedByName: v.optional(v.string()),
    files: v.array(v.object({ storageId: v.id("_storage"), name: v.string(), type: v.string(), at: v.number() })),
    createdBy: v.string(),
    createdAt: v.number(),
  })
    .index("by_supplier", ["supplierId", "createdAt"])
    .index("by_po", ["poId"])
    .index("by_status", ["status", "createdAt"]),

  // "Product come in" — goods received into a warehouse
  receipts: defineTable({
    code: v.number(),
    locationId: v.id("locations"),
    poId: v.optional(v.id("purchaseOrders")),
    supplierId: v.optional(v.id("suppliers")),
    supplier: v.optional(v.string()),
    note: v.optional(v.string()),
    items: v.array(
      v.object({
        variantId: v.id("variants"),
        sku: v.string(),
        name: v.string(),
        qty: v.number(),
        unitCost: v.number(),
        damaged: v.optional(v.number()),
      }),
    ),
    totalQty: v.number(),
    totalCost: v.number(),
    byName: v.string(),
    at: v.number(),
    shopifySync: v.optional(v.any()), // { status: done | failed | skipped, at, error?, pushed?, missing? }
  }).index("by_at", ["at"]),

  customers: defineTable({
    code: v.number(),
    name: v.string(),
    phone: v.string(), // normalized 01XXXXXXXXX
    email: v.optional(v.string()),
    address: v.optional(v.string()),
    city: v.optional(v.string()),
    tag: v.string(), // NEW | REGULAR | VIP | RISKY
    source: v.optional(v.string()),
    orderCount: v.number(),
    deliveredCount: v.number(),
    returnedCount: v.number(),
    cancelledCount: v.number(),
    totalSpent: v.number(),
    lastOrderAt: v.optional(v.number()),
    note: v.optional(v.string()),
    manager: v.optional(v.string()),
    smsCount: v.optional(v.number()),
    customerType: v.optional(v.string()),
    dob: v.optional(v.string()), // "YYYY-MM-DD", given once on the order form (optional) — powers the Dashboard's birthday panel
    // Birthday wishes: sent automatically every day for anyone whose dob matches today (email + SMS go straight
    // out; WhatsApp is drafted and queued for a human tap, same as win-back, to stay clear of automation bans).
    // Customer Care can also send/resend by hand from the Dashboard panel — same timestamps either way.
    birthdayEmailAt: v.optional(v.number()),
    birthdaySmsAt: v.optional(v.number()),
    birthdayWaQueuedAt: v.optional(v.number()),
    deletedAt: v.optional(v.number()),
    // Tier 1 — one-time buyer who never came back: last time each channel reached them. No longer "send once
    // ever" — these now double as the repeat-nudge clock (resent every winback.REPEAT1_DAYS until they order again).
    winBackAt: v.optional(v.number()),
    waQueuedAt: v.optional(v.number()),
    winbackEmailAt: v.optional(v.number()),
    // Tier 2 — repeat buyer (2+ orders) who has since gone quiet: separate clock per channel, first nudge at
    // winback.TIER2_FIRST_DAYS after their last order, then re-nudged every winback.TIER2_REPEAT_DAYS.
    winBack2At: v.optional(v.number()),
    waQueued2At: v.optional(v.number()),
    winbackEmail2At: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_phone", ["phone"])
    .index("by_created", ["createdAt"])
    .searchIndex("search_name", { searchField: "name" }),

  orders: defineTable({
    invoiceNo: v.number(),
    status: orderStatus,
    source: v.string(),
    externalId: v.optional(v.string()),
    externalName: v.optional(v.string()),
    customerId: v.id("customers"),
    customerName: v.string(),
    phone: v.string(),
    email: v.optional(v.string()),
    address: v.string(),
    cityName: v.optional(v.string()),
    pathaoCityId: v.optional(v.number()),
    pathaoZoneId: v.optional(v.number()),
    pathaoAreaId: v.optional(v.number()),
    zoneName: v.optional(v.string()),
    areaName: v.optional(v.string()),
    locationId: v.id("locations"),
    deliveryType: v.string(), // regular | express | pickup
    items: v.array(orderItem),
    subtotal: v.number(),
    discount: v.number(),
    deliveryFee: v.number(),
    paidAmount: v.number(),
    total: v.number(), // subtotal - item discounts - discount + deliveryFee
    due: v.number(),
    paymentMethod: v.optional(v.string()),
    courier: v.optional(v.string()), // pathao | manual | pickup
    consignmentId: v.optional(v.string()),
    exchangeCheckedAt: v.optional(v.number()),
    autoCall: v.optional(v.any()), // last automatic confirmation call: { result: confirmed | cancel | agent | no_answer, at, attempts } // last automatic look on Pathao for this exchange's parcels
    csat: v.optional(v.any()), // last post-delivery feedback call: { outcome, note?, byName, at } — separate from callCount/lastCallOutcome, which drive the pre-delivery confirmation-call cron
    csatFollowUpAt: v.optional(v.number()), // feedback call needs a retry (customer didn't pick up etc), mirrors followUpAt
    returnCsat: v.optional(v.any()), // last post-return feedback call: { outcome, note?, byName, at } — mirrors csat, but for a returned/damaged order instead of a delivered one. Separate from `reason`, which is the category logged when the return was first raised, not a call made to the customer about it.
    returnCsatFollowUpAt: v.optional(v.number()), // return feedback call needs a retry, mirrors csatFollowUpAt
    recovery: v.optional(v.any()), // last recovery call after an at-fault return: { outcome, note?, byName, at } — did we win the customer back with a fresh order
    recoveryFollowUpAt: v.optional(v.number()), // recovery call needs a retry, mirrors csatFollowUpAt
    recoveredOrderId: v.optional(v.id("orders")), // set on the ORIGINAL (returned) order once a recovery call wins a fresh order — points to that new order
    recoveryOfId: v.optional(v.id("orders")), // set on the NEW order created from a recovery call — points back to the original returned order it replaces. A normal order (not an exchange): the old item is already back in hand, not something courier collects, so it ships as a fresh sale, not an exchange parcel.
    returnConsignmentId: v.optional(v.string()), // Pathao "RE…" parcel bringing the old item back (exchange)
    courierStatus: v.optional(v.string()),
    courierFee: v.optional(v.number()),
    courierError: v.optional(v.string()),
    customerNote: v.optional(v.string()),
    discountCode: v.optional(v.string()), // promo code used on the website (see convex/discounts.ts)
    callCount: v.number(),
    lastCallOutcome: v.optional(v.string()),
    printedAt: v.optional(v.number()),
    shippingDate: v.optional(v.number()),
    createdByName: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
    statusChangedAt: v.number(),
    reason: v.optional(v.string()), // short category — a preset like "Wrong size sent", never raw courier/migration text
    reasonNote: v.optional(v.string()), // the customer's own words (Bangla or English) — real unstructured data for later analysis, separate from the category above
    reasonBy: v.optional(v.string()),
    reasonAt: v.optional(v.number()),
    // ---- Nuport parity ----
    invoiceCode: v.optional(v.string()), // legacy codes like SO-0005
    deliveryPartnerId: v.optional(v.id("deliveryPartners")),
    deliveryPartnerName: v.optional(v.string()),
    followUpAt: v.optional(v.number()),
    autoApproveAt: v.optional(v.number()),
    approvedAt: v.optional(v.number()),
    shippedAt: v.optional(v.number()),
    deliveredAt: v.optional(v.number()),
    isExchange: v.optional(v.boolean()),
    exchangeOfId: v.optional(v.id("orders")),
    ipAddress: v.optional(v.string()),
    origin: v.optional(v.string()),
    campaignId: v.optional(v.string()),
    additionalInfo: v.optional(v.string()),
    noteCount: v.optional(v.number()),
    itemCount: v.optional(v.number()),
    hasUpsell: v.optional(v.boolean()),
    preOrderFrom: v.optional(v.union(v.literal("china"), v.literal("bangladesh"))),
    preOrder: v.optional(v.boolean()), // has a pre-order product (SKU "PO-…" or product marked pre-order)
    returnedQty: v.optional(v.number()),
    purchaseCost: v.optional(v.number()),
    codCost: v.optional(v.number()),
    courierCost: v.optional(v.number()),
    otherCost: v.optional(v.number()),
    assignedTo: v.optional(v.string()),
    deletedAt: v.optional(v.number()),
    imported: v.optional(v.boolean()),
    lastNote: v.optional(v.string()),
    lastNoteBy: v.optional(v.string()),
    // ---- Advance-payment hold (Task 4) ----
    // Only ever set together with one of the ADVANCE_REASONS. All three are optional so every order created
    // before this feature — and every ordinary hold/cancel — is a perfectly valid document.
    expectedAdvanceAmount: v.optional(v.number()), // whole taka the customer was asked for
    promisedPaymentDate: v.optional(v.number()), // epoch ms of the day the advance was promised for
    advanceClearedAt: v.optional(v.number()), // set when the hold is resolved, so a stale promise can't linger
    // Machine-readable "why the order died" for the two advance-driven cancels (both map to refused_advance).
    // Optional so every order that predates this, and every cancel for an ordinary reason, stays valid.
    cancelReason: v.optional(v.string()),

    // ---- Pathao money (synced from Pathao invoices) ----
    courierPaid: v.optional(v.boolean()), // Pathao has paid this parcel's money to us
    courierInvoiceId: v.optional(v.string()),
    courierPaidAt: v.optional(v.number()),
    courierCollected: v.optional(v.number()), // cash Pathao collected from the customer
    courierPayout: v.optional(v.number()), // what Pathao paid us for this parcel (collected - fees)
    courierLinkedBy: v.optional(v.string()), // how we found the Pathao parcel: order no / manual
  })
    .index("by_status", ["status", "createdAt"])
    .index("by_exchange", ["isExchange", "createdAt"])
    .index("by_status_changed", ["status", "statusChangedAt"])
    .index("by_deleted", ["deletedAt"])
    .index("by_delivered", ["deliveredAt"])
    .index("by_approved", ["approvedAt"])
    .index("by_shipped", ["shippedAt"])
    .index("by_shipping", ["shippingDate"])
    .index("by_invoice_code", ["invoiceCode"])
    .index("by_created", ["createdAt"])
    .index("by_invoice", ["invoiceNo"])
    .index("by_external", ["externalId"])
    .index("by_customer", ["customerId", "createdAt"])
    .index("by_phone", ["phone"])
    .index("by_consignment", ["consignmentId"])
    .index("by_courier_invoice", ["courierInvoiceId"])
    .index("by_auto_approve", ["autoApproveAt"])
    // For BlackBole Marketing OS: pulls orders changed since its last sync (convex/marketingFeed.ts)
    .index("by_updated", ["updatedAt"]),

  // Order timeline: system logs, internal notes and customer-care calls
  orderEvents: defineTable({
    orderId: v.id("orders"),
    type: v.string(), // log | note | call | payment
    text: v.string(),
    outcome: v.optional(v.string()),
    byName: v.string(),
    at: v.number(),
  }).index("by_order", ["orderId", "at"]),

  payments: defineTable({
    orderId: v.id("orders"),
    method: v.string(),
    amount: v.number(),
    reference: v.optional(v.string()),
    byName: v.string(),
    at: v.number(),
  }).index("by_order", ["orderId"]),

  counters: defineTable({ name: v.string(), value: v.number() }).index("by_name", ["name"]),

  deliveryPartners: defineTable({
    code: v.number(),
    name: v.string(),
    provider: v.string(), // pathao | custom
    contactPerson: v.optional(v.string()),
    phone: v.optional(v.string()),
    locationId: v.optional(v.id("locations")),
    pathaoStoreId: v.optional(v.number()),
    useOwnCredentials: v.optional(v.boolean()),
    credentials: v.optional(v.any()), // per-partner Pathao login (server-only)
    isExchange: v.optional(v.boolean()),
    active: v.boolean(),
    deletedAt: v.optional(v.number()),
    createdAt: v.number(),
  }),

  expenses: defineTable({
    code: v.number(),
    head: v.string(),
    amount: v.number(),
    month: v.string(), // YYYY-MM
    status: v.string(), // requested | approved | paid | refused
    locationId: v.optional(v.id("locations")),
    note: v.optional(v.string()),
    requestedBy: v.string(),
    decidedBy: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_month", ["month"]),

  reports: defineTable({
    code: v.number(),
    type: v.string(),
    params: v.any(),
    status: v.string(), // running | ready | failed
    rows: v.optional(v.any()),
    columns: v.optional(v.array(v.string())),
    error: v.optional(v.string()),
    createdBy: v.string(),
    createdAt: v.number(),
  }).index("by_created", ["createdAt"]),

  blocks: defineTable({
    kind: v.string(), // phone | ip
    value: v.string(),
    reason: v.optional(v.string()),
    active: v.boolean(),
    createdBy: v.string(),
    createdAt: v.number(),
  }).index("by_value", ["kind", "value"]),

  notifications: defineTable({
    kind: v.string(), // info | action
    title: v.string(),
    body: v.string(),
    orderId: v.optional(v.id("orders")),
    readBy: v.array(v.string()),
    at: v.number(),
  }).index("by_at", ["at"]),

  waThreads: defineTable({
    phone: v.string(), // normalized, like customers.phone (01XXXXXXXXX)
    customerId: v.optional(v.id("customers")),
    name: v.string(),
    lastText: v.string(),
    lastAt: v.number(),
    lastDirection: v.union(v.literal("in"), v.literal("out")),
    unread: v.boolean(),
  })
    .index("by_phone", ["phone"])
    .index("by_lastAt", ["lastAt"]),

  waMessages: defineTable({
    threadId: v.id("waThreads"),
    direction: v.union(v.literal("in"), v.literal("out")),
    text: v.string(),
    by: v.optional(v.string()), // staff name, or "AI win-back"
    status: v.optional(v.string()), // queued | sent | failed | received
    error: v.optional(v.string()),
    at: v.number(),
  }).index("by_thread", ["threadId", "at"]),

  // Action Center's audit trail: a real log of what was actually done on a finding — not just the static
  // description. findingId is the stable id dashboard.ts assigns each finding (e.g. "sku-returns").
  findingLogs: defineTable({
    findingId: v.string(),
    text: v.string(),
    status: v.union(v.literal("open"), v.literal("in_progress"), v.literal("resolved")),
    byName: v.string(),
    at: v.number(),
  })
    .index("by_finding", ["findingId", "at"]),

  // WhatsApp send queue: AI drafts a personalized message, a staff member taps "Open WhatsApp" (opens the real
  // app/web with the text pre-filled) and presses send themselves — no automation ever touches the WhatsApp
  // account, so the team's existing number stays 100% safe. Fed today by the win-back playbook; any future
  // Action Center finding can enqueue into this same table with its own `source`.
  waQueue: defineTable({
    customerId: v.id("customers"),
    phone: v.string(), // normalized 01XXXXXXXXX
    name: v.string(),
    text: v.string(),
    source: v.string(), // "winback" for now
    status: v.union(v.literal("pending"), v.literal("sent"), v.literal("skipped")),
    createdAt: v.number(),
    sentAt: v.optional(v.number()),
    sentBy: v.optional(v.string()),
  })
    .index("by_status", ["status", "createdAt"])
    .index("by_customer", ["customerId"]),

  smsLogs: defineTable({
    phone: v.string(),
    text: v.string(),
    orderId: v.optional(v.id("orders")),
    customerId: v.optional(v.id("customers")),
    status: v.string(),
    error: v.optional(v.string()),
    channel: v.optional(v.string()), // "email" for emails; SMS when empty
    at: v.number(),
  }).index("by_at", ["at"]),

  webhookLogs: defineTable({
    event: v.string(),
    status: v.number(),
    orderId: v.optional(v.id("orders")),
    at: v.number(),
  }).index("by_at", ["at"]),

  // Key/value settings. Secret values are only read server-side.
  settings: defineTable({ key: v.string(), value: v.any() }).index("by_key", ["key"]),
  // Automatic order confirmation calls (press 1 confirm / 2 cancel / 3 talk to us)
  autoCalls: defineTable({
    orderId: v.id("orders"),
    phone: v.string(),
    status: v.string(), // queued | calling | done
    attempt: v.number(),
    nextAt: v.number(),
    result: v.optional(v.string()), // confirmed | cancel | agent | no_answer | busy | failed | skipped
    digit: v.optional(v.string()),
    callRef: v.optional(v.string()), // the call server's own id
    durationSec: v.optional(v.number()),
    cost: v.optional(v.number()),
    note: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_status_next", ["status", "nextAt"]).index("by_order", ["orderId"]).index("by_created", ["createdAt"]),
  // deleted records kept here (nothing is lost; can be restored by hand)
  archive: defineTable({ table: v.string(), data: v.any(), reason: v.string(), byName: v.string(), at: v.number() }).index("by_at", ["at"]),
  // products whose Shopify stock must be refreshed (live stock sync)
  shopifyDirty: defineTable({ variantId: v.id("variants"), at: v.number() }).index("by_variant", ["variantId"]),

  // Daily scoreboard: numbers per day an order was made (kept up to date on every order change)
  dayStats: defineTable({ day: v.string(), st: v.any(), src: v.any(), it: v.any(), due: v.number(), q: v.number() }).index("by_day", ["day"]),

  // Saved results of heavy read-only reports (dashboard), shared by everyone for a few minutes to save database reads
  cache: defineTable({ key: v.string(), at: v.number(), value: v.any() }).index("by_key", ["key"]),

  // Shopify checkouts — the ones never finished are "abandoned carts" the team calls to win back
  checkouts: defineTable({
    checkoutId: v.string(), // Shopify checkout id, or "draft:<id>" for draft orders
    kind: v.optional(v.string()), // "checkout" (website checkout) | "draft" (COD form / draft order)
    shopName: v.optional(v.string()), // e.g. #D5839 for a draft order
    token: v.optional(v.string()),
    customerName: v.string(),
    phone: v.string(), // normalized 01XXXXXXXXX, or "" if not given
    email: v.optional(v.string()),
    address: v.string(),
    cityName: v.optional(v.string()),
    items: v.array(orderItem),
    subtotal: v.number(),
    discount: v.number(),
    deliveryFee: v.number(),
    total: v.number(),
    recoveryUrl: v.optional(v.string()),
    shopCreatedAt: v.number(),
    shopUpdatedAt: v.number(),
    // open = still abandoned · ordered = customer finished on the website · converted = we made the order · lost = not interested
    status: v.string(),
    orderId: v.optional(v.id("orders")),
    callCount: v.number(),
    lastOutcome: v.optional(v.string()),
    lastNote: v.optional(v.string()),
    lastCallBy: v.optional(v.string()),
    lastCallAt: v.optional(v.number()),
    followUpAt: v.optional(v.number()),
    closedBy: v.optional(v.string()),
    closedAt: v.optional(v.number()),
    // ---- Phase 1 / Task 3: recovery queue controls (all optional, so every legacy row stays valid) ----
    // Soft delete. Absent on older rows and therefore falsy — a legacy cart is naturally "active".
    isArchived: v.optional(v.boolean()),
    archivedAt: v.optional(v.number()),
    archivedBy: v.optional(v.string()),
    archiveReason: v.optional(v.string()),
    // Free-text internal note for the team (separate from lastNote, which is the last call outcome).
    notes: v.optional(v.string()),
    // Discount codes assigned to this cart during recovery, e.g. ["SAVE10", "EID200"].
    discountCodes: v.optional(v.array(v.string())),
    // Recovery-workflow label shown in the queue (New / Contacted / Follow-up / Interested / Not interested / Recovered).
    // A label only — it never drives stock or the tab a cart lives in; `status` still does that.
    recoveryStatus: v.optional(v.string()),
    editedAt: v.optional(v.number()),
    editedBy: v.optional(v.string()),
  })
    .index("by_checkout", ["checkoutId"])
    .index("by_token", ["token"])
    .index("by_status", ["status", "shopUpdatedAt"])
    .index("by_phone", ["phone"])
    // Only rows that actually carry isArchived: true are in this index, so the Archived tab is a cheap lookup
    // and legacy rows (no field at all) can never leak into it.
    .index("by_archived", ["isArchived", "shopUpdatedAt"]),

  // Audit trail for the abandoned-cart queue: who changed or archived a cart, when, and what changed.
  // Append-only — nothing here is ever patched or deleted, so the history stays trustworthy.
  checkoutAudit: defineTable({
    checkoutId: v.id("checkouts"),
    action: v.union(v.literal("modify"), v.literal("archive"), v.literal("unarchive")),
    byName: v.string(),
    at: v.number(),
    // Field names that changed (never the values — phone/address are personal data and stay on the cart itself).
    fields: v.optional(v.array(v.string())),
    reason: v.optional(v.string()),
  })
    .index("by_checkout", ["checkoutId", "at"])
    .index("by_at", ["at"]),

  // Courier-wide delivery history for a phone number (Pathao merchant network), cached
  courierChecks: defineTable({
    phone: v.string(),
    provider: v.string(), // pathao
    at: v.number(),
    data: v.any(),
  }).index("by_phone", ["phone", "provider"]),

  // Pathao payout invoices (what Pathao collected and paid us)
  pathaoInvoices: defineTable({
    invoiceId: v.string(),
    createdAt: v.number(),
    collected: v.number(),
    deliveryFee: v.number(),
    codFee: v.number(),
    discount: v.number(),
    totalFee: v.number(),
    receivable: v.number(),
    status: v.string(), // paid | unpaid
    parcels: v.number(),
    matched: v.number(),
    syncedAt: v.number(),
  }).index("by_invoice", ["invoiceId"]).index("by_created", ["createdAt"]),

  // Pathao parcel tracking (timeline + costs), cached per order
  courierTracking: defineTable({
    orderId: v.id("orders"),
    at: v.number(),
    data: v.any(),
  }).index("by_order", ["orderId"]),

  // Cached Pathao city / zone / area lists
  pathaoPlaces: defineTable({
    kind: v.string(), // city | zone | area
    parentId: v.number(),
    placeId: v.number(),
    name: v.string(),
  }).index("by_kind_parent", ["kind", "parentId"]),

  // Website collections (blackbole.com), edited on the Website page
  webCollections: defineTable({
    handle: v.string(),
    title: v.string(),
    html: v.optional(v.string()),
    image: v.optional(v.union(v.string(), v.null())),
    seo: v.optional(v.any()),
    productHandles: v.array(v.string()),
    // Automatic collection (Shopify smart collection): products matching these rules join by themselves
    rules: v.optional(v.any()), // { match: "all"|"any", conditions: [{ field, op, values }] } — see convex/websiteRules.ts
    sort: v.optional(v.string()), // manual | best | newest | oldest | price-asc | price-desc | title-asc | title-desc
    published: v.optional(v.boolean()), // false = hidden from the website (missing = shown, like before)
    templateSuffix: v.optional(v.string()), // theme layout "collection.<suffix>"; missing = the default collection layout
    updatedAt: v.number(),
  }).index("by_handle", ["handle"]),

  // Discount codes for the website (Website → Discounts). Percent stored as a whole number (10 = 10%).
  discounts: defineTable({
    code: v.string(), // uppercase
    title: v.optional(v.string()),
    type: v.union(v.literal("percent"), v.literal("amount")),
    value: v.number(),
    scope: v.union(v.literal("all"), v.literal("collections"), v.literal("products")),
    items: v.array(v.string()), // collection or product handles
    minSubtotal: v.optional(v.number()),
    onlineOnly: v.optional(v.boolean()),
    startsAt: v.optional(v.number()),
    endsAt: v.optional(v.number()),
    usageLimit: v.optional(v.number()),
    oncePerCustomer: v.optional(v.boolean()),
    // Shopify-style extras (all optional; older rows are code discounts whose kind follows from scope)
    method: v.optional(v.union(v.literal("code"), v.literal("automatic"))), // automatic: no code, code holds an internal AUTO-… id
    kind: v.optional(v.union(v.literal("products"), v.literal("order"), v.literal("bxgy"), v.literal("shipping"))),
    minQty: v.optional(v.number()), // minimum quantity of items
    combines: v.optional(v.object({ products: v.optional(v.boolean()), order: v.optional(v.boolean()), shipping: v.optional(v.boolean()) })),
    buyQty: v.optional(v.number()), // Buy X get Y: customer buys…
    buyScope: v.optional(v.union(v.literal("all"), v.literal("collections"), v.literal("products"))),
    buyItems: v.optional(v.array(v.string())),
    getQty: v.optional(v.number()), // …and gets (scope/items/type/value describe the "gets" side)
    maxUses: v.optional(v.number()), // Buy X get Y: times per order
    active: v.boolean(),
    usedCount: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_code", ["code"]),

  // Small counters for public endpoints (e.g. website order-status lookups per IP per minute)
  rateLimits: defineTable({
    key: v.string(),
    windowStart: v.number(),
    count: v.number(),
  }).index("by_key", ["key"]),

  // Newsletter sign-ups from the website footer ("Join Now"), one row per email.
  subscribers: defineTable({
    email: v.string(), // lowercase
    name: v.optional(v.string()),
    phone: v.optional(v.string()),
    source: v.string(), // footer | checkout | …
    tags: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_email", ["email"]),

  // Website content (Website → Pages, Blog, Navigation). Shapes match what the website build reads.
  webPages: defineTable({
    handle: v.string(),
    title: v.string(),
    body: v.string(), // HTML
    seo: v.optional(v.any()), // { title, description }
    isPublished: v.boolean(),
    publishedAt: v.optional(v.union(v.string(), v.null())),
    templateSuffix: v.optional(v.union(v.string(), v.null())), // "contact", "custom-shoes"… (special page layouts)
    updatedAt: v.number(),
  }).index("by_handle", ["handle"]),
  webPosts: defineTable({
    blogHandle: v.string(),
    blogTitle: v.string(),
    handle: v.string(),
    title: v.string(),
    body: v.string(), // HTML
    summary: v.optional(v.string()),
    tags: v.array(v.string()),
    author: v.optional(v.string()),
    image: v.optional(v.any()), // { url, altText, width, height } | null
    isPublished: v.boolean(),
    publishedAt: v.optional(v.union(v.string(), v.null())),
    seo: v.optional(v.any()),
    pos: v.number(),
    updatedAt: v.number(),
  }).index("by_blog_handle", ["blogHandle", "handle"]),
  webMenus: defineTable({
    handle: v.string(),
    title: v.string(),
    items: v.any(), // [{ title, url, type, items: [...] }]
    updatedAt: v.number(),
  }).index("by_handle", ["handle"]),
  webRedirects: defineTable({
    path: v.string(),
    target: v.string(),
    updatedAt: v.number(),
  }).index("by_path", ["path"]),

  // Website → Themes (like Shopify's Online Store → Themes). One live theme (what blackbole.com shows), one draft
  // (shown on the preview site, edited in Customize) and up to 10 archived ones for rolling back.
  // json = { settings, templates } — the same shape as the website's src/data/theme.json, kept as text.
  webThemes: defineTable({
    name: v.string(),
    role: v.union(v.literal("live"), v.literal("draft"), v.literal("archived")),
    json: v.string(),
    updatedAt: v.number(),
    updatedBy: v.optional(v.string()),
    publishedAt: v.optional(v.number()),
    publishedBy: v.optional(v.string()),
  }).index("by_role", ["role"]),

  // Website → Files (Shopify's Content → Files): pictures and videos uploaded for the website.
  webFiles: defineTable({
    storageId: v.optional(v.id("_storage")), // none = a picture the website already had (imported by link, not uploaded)
    url: v.string(),
    name: v.string(),
    type: v.string(), // MIME type
    size: v.number(), // bytes
    w: v.optional(v.number()),
    h: v.optional(v.number()),
    alt: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_created", ["createdAt"]).index("by_url", ["url"]),

  // Website → Products → Reviews (was Judge.me on Shopify). See convex/reviews.ts. The website reads the published
  // ones from GET /website/reviews at build time; reviews written on the website arrive as "pending".
  webReviews: defineTable({
    source: v.string(), // judgeme | website | manual
    extId: v.optional(v.string()), // Judge.me review id (re-imports update, never duplicate)
    handle: v.string(), // product URL handle
    productTitle: v.optional(v.string()),
    rating: v.number(), // 1–5
    title: v.optional(v.string()),
    body: v.string(), // plain text (new lines kept)
    author: v.string(),
    email: v.optional(v.string()),
    location: v.optional(v.string()),
    verified: v.optional(v.boolean()),
    photos: v.optional(v.array(v.string())),
    reply: v.optional(v.string()), // store reply
    status: v.string(), // published | hidden | pending
    ip: v.optional(v.string()),
    createdAt: v.number(), // review date
    updatedAt: v.number(),
  }).index("by_ext", ["extId"]).index("by_handle", ["handle"]).index("by_status", ["status"]),

  // Accountability: once a return call confirms a reason was really our own fault, the department that
  // actually caused it (see ACCOUNTABILITY_ROUTING in rules.ts) gets a flag it has to answer inside this
  // system — not a side chat nobody can trace later. One flag per order per raise; a team member closes it
  // with a real response, which is itself part of the record.
  opsFlags: defineTable({
    orderId: v.optional(v.id("orders")), // unset for a free-form question not tied to one order (e.g. "why is our return ratio high?")
    productNames: v.optional(v.array(v.string())), // the order's product names, frozen at the moment the flag was raised — so the card always shows what's at issue even if the order's items are edited later
    reason: v.string(), // the at-fault return reason that triggered this, e.g. "Wrong product sent" — or the free-form question's own text
    team: v.string(), // which department owns it — see ACCOUNTABILITY_ROUTING, and Settings → Accountability for who that is by name
    note: v.optional(v.string()), // the CX call note, for context
    status: v.string(), // "open" | "resolved"
    raisedByName: v.string(),
    raisedAt: v.number(),
    response: v.optional(v.string()), // composed, readable version of rootCause/correctiveAction/preventiveAction below — what shows in the list and what gets emailed/logged
    rootCause: v.optional(v.string()), // CAPA: what actually went wrong (the real reason, not an excuse)
    correctiveAction: v.optional(v.string()), // CAPA: what was done about this specific case
    preventiveAction: v.optional(v.string()), // CAPA: the concrete process change that stops it happening again
    resolvedByName: v.optional(v.string()),
    resolvedAt: v.optional(v.number()),
    assignee: v.optional(v.string()), // named owner this was routed to at the time (Settings → Accountability), for display even if the setting later changes
    assigneeEmail: v.optional(v.string()),
    escalatedAt: v.optional(v.number()), // first time this crossed the 2-day SLA and the ops head got pinged

    // ---- Closed-case history (Task 5) ----
    // Every field below is optional, so every flag raised before this feature — and every flag still open —
    // remains a perfectly valid document. A flag with no closedAt is simply still open.
    closedAt: v.optional(v.number()), // when it left the open queue: answered (resolved) or archived
    archivedAt: v.optional(v.number()), // soft-archived as a duplicate/invalid case rather than answered
    archivedBy: v.optional(v.string()),
    archiveReason: v.optional(v.string()),

    // ---- Department-lead email tracking (Task 5) ----
    // flagEmailSentAt is the idempotency latch: set once, the moment the email is queued, so re-flagging the
    // same case or double-clicking can never send a second one. The other two record what happened when no
    // email could go out, so a missing lead address is visible instead of silent.
    flagEmailSentAt: v.optional(v.number()),
    flagEmailAttemptedAt: v.optional(v.number()),
    flagEmailSkippedReason: v.optional(v.string()),
    // The address the lead email actually went to, so "who was told about this?" is answerable from the record
    // itself — and so a re-route can be shown to have reached the new lead and not the old one.
    flagEmailTo: v.optional(v.string()),

    // ---- Raiser email tracking ----
    // Same idempotency pattern as flagEmailSentAt, but for the person who raised the flag in the first place —
    // they get their own confirmation that it was routed, and later their own notice when it's resolved.
    raiserEmailSentAt: v.optional(v.number()),
    raiserEmailSkippedReason: v.optional(v.string()),
    resolvedEmailSentAt: v.optional(v.number()), // latch for the "both parties told it's resolved" email, so a resolve can never double-send

    // ---- Super Admin edit / re-route (additive) ----
    // A case can be raised against the wrong department, or with a typo in its title. A Super Admin fixes it in
    // place instead of archiving and re-creating (which would lose the original history). The last edit is
    // mirrored onto the flag for display; `rerouteHistory` is the full append-only trail. Every field is
    // optional, so a flag raised before this feature is still a perfectly valid document.
    editedAt: v.optional(v.number()),
    editedBy: v.optional(v.string()),
    previousTeam: v.optional(v.string()),
    newTeam: v.optional(v.string()),
    previousAssignee: v.optional(v.string()),
    newAssignee: v.optional(v.string()),
    rerouteHistory: v.optional(v.array(v.object({
      editedAt: v.number(),
      editedBy: v.string(),
      previousTeam: v.string(),
      newTeam: v.string(),
      previousAssignee: v.optional(v.string()),
      newAssignee: v.optional(v.string()),
      // which fields this particular edit actually changed, so the trail reads "title + note" rather than
      // implying a re-route that never happened
      changed: v.optional(v.array(v.string())),
      // why the new lead was or wasn't emailed, mirroring flagEmailSkippedReason for that single edit
      emailNote: v.optional(v.string()),
    }))),
  }).index("by_order", ["orderId"]).index("by_status", ["status", "raisedAt"]).index("by_team_status", ["team", "status", "raisedAt"]).index("by_closed", ["closedAt"]),

  // ---------------------------------------------------------------------------------------------------------------
  // KPI / team performance leaderboard. Deliberately an append-only point LEDGER (kpiEvents), not a running
  // total on each staff record — a week's or month's score is always computed fresh by summing the events in
  // that window, so there's nothing to drift out of sync and no migration needed if the point values change
  // later. kpiRules holds the current point value for each scoring rule, editable from Settings without a
  // redeploy; kpiPayouts is the paper trail for the monthly cash prize once a Super Admin finalizes a month —
  // the app only ever records who's owed what and whether it's been paid, it never moves real money itself.
  // ---------------------------------------------------------------------------------------------------------------
  kpiEvents: defineTable({
    staffName: v.string(), // who earns/loses the points — always a real, active staff member (see awardPoints)
    points: v.number(), // positive or negative
    ruleKey: v.string(), // which rule this came from, or "manual" for a Super Admin's own entry
    label: v.string(), // the line shown in the point feed, e.g. "Recovered an abandoned checkout — BB-11234"
    orderId: v.optional(v.id("orders")),
    flagId: v.optional(v.id("opsFlags")),
    byName: v.optional(v.string()), // who recorded a manual award (unset for an automatic one)
    at: v.number(),
  })
    .index("by_staff", ["staffName", "at"])
    .index("by_at", ["at"])
    // Lets an order-linked rule check "has this order already earned this rule's points" before awarding
    // again — some status transitions (e.g. an advance clearing) can otherwise re-fire on a later, unrelated
    // move of the same order.
    .index("by_rule_order", ["ruleKey", "orderId"]),

  kpiRules: defineTable({
    key: v.string(), // stable id, matches a DEFAULT_RULES key in convex/kpi.ts
    label: v.string(),
    points: v.number(), // overrides the default shown in convex/kpi.ts; can be negative
    active: v.boolean(), // turned off entirely — an inactive automatic rule simply stops awarding
  }).index("by_key", ["key"]),

  kpiPayouts: defineTable({
    month: v.string(), // "2026-11" — the calendar month this prize is for
    rank: v.number(), // 1, 2, or 3
    staffName: v.string(),
    points: v.number(), // their monthly total at the moment the month was finalized, for the record
    amount: v.number(), // taka owed
    status: v.string(), // "pending" | "paid"
    paidAt: v.optional(v.number()),
    paidByName: v.optional(v.string()),
    note: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_month", ["month"]),

  // ---------------------------------------------------------------------------------------------------------------
  // Company revenue target — one row per Dhaka calendar month ("2026-11"). Revenue is delivered orders' total,
  // counted on the day of delivery; the daily split is worked out live from this plus the orders (see
  // convex/targetMath.ts), so nothing here ever needs correcting when a late delivery lands.
  // ---------------------------------------------------------------------------------------------------------------
  revenueTargets: defineTable({
    month: v.string(), // "2026-11"
    amount: v.number(), // whole taka for the month
    setByName: v.string(),
    updatedAt: v.number(),
    /** First day of the period when the target was set before its month began (e.g. "2026-10-31"). */
    start: v.optional(v.string()),
    /** True when the system set this target itself from sales and stock (a person saving one clears it). */
    auto: v.optional(v.boolean()),
    /** Pairs-per-product plan for the month (targetPlan.ts ProductPlan), re-made weekly. */
    plan: v.optional(v.any()),
  }).index("by_month", ["month"]),
})
