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
  }),

  products: defineTable({
    name: v.string(),
    category: v.optional(v.string()),
    description: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
    active: v.boolean(),
    preOrder: v.optional(v.boolean()), // takes long to arrive; orders with it go to the Pre-Order tab
    preOrderFrom: v.optional(v.union(v.literal("china"), v.literal("bangladesh"))), // where it comes from (default China)
    createdAt: v.number(),
    deletedAt: v.optional(v.number()),
  }).searchIndex("search_name", { searchField: "name" }),

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
    byName: v.string(),
    at: v.number(),
  })
    .index("by_po", ["poId"])
    .index("by_supplier", ["supplierId"]),

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
    deletedAt: v.optional(v.number()),
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
    courierStatus: v.optional(v.string()),
    courierFee: v.optional(v.number()),
    courierError: v.optional(v.string()),
    customerNote: v.optional(v.string()),
    callCount: v.number(),
    lastCallOutcome: v.optional(v.string()),
    printedAt: v.optional(v.number()),
    shippingDate: v.optional(v.number()),
    createdByName: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
    statusChangedAt: v.number(),
    reason: v.optional(v.string()),
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
    // ---- Pathao money (synced from Pathao invoices) ----
    courierPaid: v.optional(v.boolean()), // Pathao has paid this parcel's money to us
    courierInvoiceId: v.optional(v.string()),
    courierPaidAt: v.optional(v.number()),
    courierCollected: v.optional(v.number()), // cash Pathao collected from the customer
    courierPayout: v.optional(v.number()), // what Pathao paid us for this parcel (collected - fees)
    courierLinkedBy: v.optional(v.string()), // how we found the Pathao parcel: order no / manual
  })
    .index("by_status", ["status", "createdAt"])
    .index("by_status_changed", ["status", "statusChangedAt"])
    .index("by_deleted", ["deletedAt"])
    .index("by_delivered", ["deliveredAt"])
    .index("by_approved", ["approvedAt"])
    .index("by_shipping", ["shippingDate"])
    .index("by_invoice_code", ["invoiceCode"])
    .index("by_created", ["createdAt"])
    .index("by_invoice", ["invoiceNo"])
    .index("by_external", ["externalId"])
    .index("by_customer", ["customerId", "createdAt"])
    .index("by_phone", ["phone"])
    .index("by_consignment", ["consignmentId"])
    .index("by_courier_invoice", ["courierInvoiceId"]),

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

  smsLogs: defineTable({
    phone: v.string(),
    text: v.string(),
    orderId: v.optional(v.id("orders")),
    customerId: v.optional(v.id("customers")),
    status: v.string(),
    error: v.optional(v.string()),
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
  })
    .index("by_checkout", ["checkoutId"])
    .index("by_token", ["token"])
    .index("by_status", ["status", "shopUpdatedAt"])
    .index("by_phone", ["phone"]),

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
})
