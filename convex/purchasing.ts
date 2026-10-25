import { v, ConvexError } from "convex/values"
import { query } from "./_generated/server"
import { mutation } from "./functions"
import type { Doc, Id } from "./_generated/dataModel"
import { bumpStock, currentStaff, nextCounter, requirePerm } from "./lib"

// ---------------- Suppliers ----------------
const counted = (p: Doc<"purchaseOrders">) => p.status !== "draft" && p.status !== "cancelled"

/** Supplier account: opening due + purchases − all payments. */
async function supplierAccount(ctx: any, sp: Doc<"suppliers">) {
  const pos: Doc<"purchaseOrders">[] = (await ctx.db.query("purchaseOrders").withIndex("by_supplier", (q: any) => q.eq("supplierId", sp._id)).collect()).filter(counted)
  const payments: Doc<"supplierPayments">[] = await ctx.db.query("supplierPayments").withIndex("by_supplier", (q: any) => q.eq("supplierId", sp._id)).collect()
  const opening = sp.openingDue ?? 0
  const purchased = pos.reduce((t, p) => t + p.total, 0)
  const paid = payments.reduce((t, p) => t + p.amount, 0)
  const unlinkedPaid = payments.filter((p) => !p.poId).reduce((t, p) => t + p.amount, 0)
  return {
    pos, payments, opening, purchased, paid,
    openingLeft: Math.max(0, opening - unlinkedPaid),
    advance: Math.max(0, unlinkedPaid - opening), // paid in advance, not yet used by a purchase
    due: opening + purchased - paid,
    lastAt: pos.reduce((t, p) => Math.max(t, p.createdAt), 0) || undefined,
  }
}

export const listSuppliers = query({
  args: {},
  handler: async (ctx) => {
    const s = await currentStaff(ctx)
    if (!s) return []
    const suppliers = await ctx.db.query("suppliers").collect()
    const out = await Promise.all(suppliers.map(async (sp) => {
      const a = await supplierAccount(ctx, sp)
      return { ...sp, poCount: a.pos.length, purchased: a.purchased, paid: a.paid, due: a.due, opening: a.opening, lastAt: a.lastAt }
    }))
    return out.sort((a, b) => b.due - a.due || a.name.localeCompare(b.name))
  },
})

/** Statement like a bank statement: purchases add to what we owe, payments reduce it. */
export const supplierStatement = query({
  args: { id: v.id("suppliers") },
  handler: async (ctx, { id }) => {
    const s = await currentStaff(ctx)
    if (!s) return null
    const sp = await ctx.db.get(id)
    if (!sp) return null
    const a = await supplierAccount(ctx, sp)
    const poCode = (n: number) => `PO-${String(n).padStart(4, "0")}`
    const entries: { at: number; kind: "opening" | "purchase" | "payment"; text: string; debit: number; credit: number; poId?: Id<"purchaseOrders"> }[] = []
    if (a.opening) entries.push({ at: sp.createdAt, kind: "opening", text: "Previous due (before BlackBole Ops)", debit: a.opening, credit: 0 })
    for (const p of a.pos) entries.push({ at: p.orderedAt ?? p.createdAt, kind: "purchase", text: `${poCode(p.code)}${p.supplierRef ? ` · Inv ${p.supplierRef}` : ""} · ${p.items.reduce((t, i) => t + i.orderedQty, 0)} pcs`, debit: p.total, credit: 0, poId: p._id })
    for (const pay of a.payments) {
      const po = pay.poId ? a.pos.find((p) => p._id === pay.poId) : undefined
      entries.push({ at: pay.at, kind: "payment", text: `Paid · ${pay.method}${pay.reference ? ` · ${pay.reference}` : ""}${po ? ` · for ${poCode(po.code)}` : pay.poId ? "" : " · on account"}`, debit: 0, credit: pay.amount, poId: pay.poId })
    }
    entries.sort((x, y) => x.at - y.at || (x.kind === "payment" ? 1 : -1))
    let bal = 0
    const rows = entries.map((e) => { bal += e.debit - e.credit; return { ...e, balance: bal } })
    const openPOs = a.pos.filter((p) => p.due > 0).sort((x, y) => x.createdAt - y.createdAt).map((p) => ({ _id: p._id, code: p.code, total: p.total, paid: p.paid, due: p.due, createdAt: p.createdAt, status: p.status }))
    return { supplier: sp, purchased: a.purchased, paid: a.paid, due: a.due, opening: a.opening, openingLeft: a.openingLeft, advance: a.advance, rows: rows.reverse(), openPOs }
  },
})

/** Pay a supplier any amount: clears the previous due first, then the oldest unpaid purchases. Extra stays as advance. */
export const paySupplier = mutation({
  args: { id: v.id("suppliers"), amount: v.number(), method: v.string(), reference: v.optional(v.string()), note: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const me = await requirePerm(ctx, "purchases.pay")
    if (a.amount <= 0) throw new ConvexError("Amount must be more than 0")
    const sp = await ctx.db.get(a.id)
    if (!sp) throw new ConvexError("Supplier not found")
    const acc = await supplierAccount(ctx, sp)
    const now = Date.now()
    let left = a.amount
    const base = { supplierId: a.id, method: a.method, reference: a.reference, note: a.note, byName: me.staff.name, at: now }
    const applied: string[] = []
    if (acc.openingLeft > 0) {
      const x = Math.min(left, acc.openingLeft)
      await ctx.db.insert("supplierPayments", { ...base, amount: x })
      left -= x
      applied.push(`previous due ${x}`)
    }
    for (const po of acc.pos.filter((p) => p.due > 0).sort((x, y) => (x.orderedAt ?? x.createdAt) - (y.orderedAt ?? y.createdAt))) {
      if (left <= 0) break
      const x = Math.min(left, po.due)
      await ctx.db.insert("supplierPayments", { ...base, poId: po._id, amount: x })
      await ctx.db.patch(po._id, { paid: po.paid + x, due: Math.max(0, po.due - x), updatedAt: now })
      left -= x
      applied.push(`PO-${String(po.code).padStart(4, "0")} ${x}`)
    }
    if (left > 0) {
      await ctx.db.insert("supplierPayments", { ...base, amount: left })
      applied.push(`advance ${left}`)
    }
    return { applied }
  },
})

export const saveSupplier = mutation({
  args: {
    id: v.optional(v.id("suppliers")),
    name: v.string(),
    contactPerson: v.optional(v.string()),
    phone: v.optional(v.string()),
    email: v.optional(v.string()),
    address: v.optional(v.string()),
    note: v.optional(v.string()),
    openingDue: v.optional(v.number()),
    active: v.boolean(),
  },
  handler: async (ctx, { id, ...a }) => {
    await requirePerm(ctx, "purchases.manage")
    if (!a.name.trim()) throw new ConvexError("Supplier name is required")
    const data = { ...a, name: a.name.trim() }
    if (id) {
      await ctx.db.patch(id, data)
      // keep the name on open POs in sync
      for (const p of await ctx.db.query("purchaseOrders").withIndex("by_supplier", (q) => q.eq("supplierId", id)).collect()) {
        if (p.supplierName !== data.name) await ctx.db.patch(p._id, { supplierName: data.name })
      }
      return id
    }
    return await ctx.db.insert("suppliers", { ...data, createdAt: Date.now() })
  },
})

// ---------------- Purchase orders ----------------
const lineInput = v.object({ variantId: v.id("variants"), orderedQty: v.number(), unitCost: v.number() })

function totals(items: { orderedQty: number; unitCost: number }[], discount: number, shippingCost: number, otherCost: number, paid: number) {
  const subtotal = items.reduce((s, i) => s + i.orderedQty * i.unitCost, 0)
  const total = Math.max(0, subtotal - discount + shippingCost + otherCost)
  return { subtotal, total, due: Math.max(0, total - paid) }
}

export const listPOs = query({
  args: { status: v.optional(v.string()), supplierId: v.optional(v.id("suppliers")) },
  handler: async (ctx, { status, supplierId }) => {
    const s = await currentStaff(ctx)
    if (!s) return null
    let rows = supplierId
      ? await ctx.db.query("purchaseOrders").withIndex("by_supplier", (q) => q.eq("supplierId", supplierId)).order("desc").collect()
      : await ctx.db.query("purchaseOrders").withIndex("by_created").order("desc").collect()
    if (status === "open") rows = rows.filter((p) => ["ordered", "shipped", "partial"].includes(p.status))
    else if (status) rows = rows.filter((p) => p.status === status)
    const locs = await ctx.db.query("locations").collect()
    return rows.map((p) => ({
      ...p,
      locationName: locs.find((l) => l._id === p.locationId)?.name ?? "",
      orderedUnits: p.items.reduce((t, i) => t + i.orderedQty, 0),
      receivedUnits: p.items.reduce((t, i) => t + i.receivedQty, 0),
      damagedUnits: p.items.reduce((t, i) => t + i.damagedQty, 0),
    }))
  },
})

export const getPO = query({
  args: { id: v.id("purchaseOrders") },
  handler: async (ctx, { id }) => {
    const s = await currentStaff(ctx)
    if (!s) return null
    const po = await ctx.db.get(id)
    if (!po) return { missing: true as const }
    const location = await ctx.db.get(po.locationId)
    const supplier = po.supplierId ? await ctx.db.get(po.supplierId) : null
    const receipts = (await ctx.db.query("receipts").collect()).filter((r) => r.poId === id).sort((a, b) => b.at - a.at)
    const payments = await ctx.db.query("supplierPayments").withIndex("by_po", (q) => q.eq("poId", id)).collect()
    const files = await Promise.all(po.files.map(async (f) => ({ ...f, url: await ctx.storage.getUrl(f.storageId) })))
    // current stock + images for each line
    const lines = await Promise.all(po.items.map(async (i) => {
      const vr = await ctx.db.get(i.variantId)
      const p = vr ? await ctx.db.get(vr.productId) : null
      return { ...i, imageUrl: vr?.imageUrl ?? p?.imageUrl, price: vr?.price ?? 0, currentCost: vr?.purchasePrice ?? 0 }
    }))
    return { missing: false as const, po: { ...po, items: lines, files }, location, supplier, receipts, payments: payments.sort((a, b) => b.at - a.at) }
  },
})

async function buildLines(ctx: any, lines: { variantId: Id<"variants">; orderedQty: number; unitCost: number }[], old?: Doc<"purchaseOrders">["items"]) {
  const merged = new Map<string, { variantId: Id<"variants">; orderedQty: number; unitCost: number }>()
  for (const l of lines) {
    if (l.orderedQty <= 0) continue
    const prev = merged.get(l.variantId)
    merged.set(l.variantId, prev ? { ...prev, orderedQty: prev.orderedQty + l.orderedQty } : { ...l })
  }
  const out: Doc<"purchaseOrders">["items"] = []
  for (const l of merged.values()) {
    const vr = await ctx.db.get(l.variantId)
    if (!vr) continue
    const p = await ctx.db.get(vr.productId)
    const was = old?.find((o) => o.variantId === l.variantId)
    if (was && l.orderedQty < was.receivedQty + was.damagedQty) {
      throw new ConvexError(`${vr.sku}: ordered quantity can't be less than already received (${was.receivedQty + was.damagedQty})`)
    }
    out.push({
      variantId: l.variantId, sku: vr.sku, name: p?.name ?? vr.sku, title: vr.title,
      orderedQty: l.orderedQty, unitCost: Math.max(0, l.unitCost),
      receivedQty: was?.receivedQty ?? 0, damagedQty: was?.damagedQty ?? 0,
    })
  }
  // lines that were already received can't be removed
  for (const o of old ?? []) {
    if (!out.some((x) => x.variantId === o.variantId) && o.receivedQty + o.damagedQty > 0) {
      throw new ConvexError(`${o.sku} was already received and can't be removed`)
    }
  }
  return out
}

export const savePO = mutation({
  args: {
    id: v.optional(v.id("purchaseOrders")),
    supplierId: v.optional(v.id("suppliers")),
    supplierName: v.optional(v.string()),
    locationId: v.id("locations"),
    supplierRef: v.optional(v.string()),
    tracking: v.optional(v.string()),
    expectedAt: v.optional(v.number()),
    lines: v.array(lineInput),
    discount: v.number(),
    shippingCost: v.number(),
    otherCost: v.number(),
    note: v.optional(v.string()),
    status: v.optional(v.string()), // draft | ordered
  },
  handler: async (ctx, a) => {
    const me = await requirePerm(ctx, "purchases.manage")
    const old = a.id ? await ctx.db.get(a.id) : null
    if (old && old.status === "cancelled") throw new ConvexError("This purchase is cancelled")
    const items = await buildLines(ctx, a.lines, old?.items)
    if (items.length === 0) throw new ConvexError("Add at least one product with a quantity")
    const supplier = a.supplierId ? await ctx.db.get(a.supplierId) : null
    const supplierName = supplier?.name ?? a.supplierName?.trim() ?? ""
    if (!supplierName) throw new ConvexError("Choose a supplier")
    const t = totals(items, a.discount, a.shippingCost, a.otherCost, old?.paid ?? 0)
    const now = Date.now()
    const status = old && !["draft", "ordered"].includes(old.status) ? old.status : (a.status ?? old?.status ?? "draft")
    const data = {
      supplierId: a.supplierId, supplierName, locationId: a.locationId, supplierRef: a.supplierRef, tracking: a.tracking,
      expectedAt: a.expectedAt, items, discount: a.discount, shippingCost: a.shippingCost, otherCost: a.otherCost,
      subtotal: t.subtotal, total: t.total, due: t.due, note: a.note, status, updatedAt: now,
      ...(status === "ordered" && !old?.orderedAt ? { orderedAt: now } : {}),
    }
    if (old) {
      await ctx.db.patch(old._id, data)
      return old._id
    }
    const code = await nextCounter(ctx, "po", 1)
    return await ctx.db.insert("purchaseOrders", { ...data, code, paid: 0, files: [], createdBy: me.staff.name, createdAt: now })
  },
})

export const setPOStatus = mutation({
  args: { id: v.id("purchaseOrders"), status: v.string(), tracking: v.optional(v.string()) },
  handler: async (ctx, { id, status, tracking }) => {
    await requirePerm(ctx, "purchases.manage")
    const po = await ctx.db.get(id)
    if (!po) throw new ConvexError("Purchase not found")
    const received = po.items.some((i) => i.receivedQty + i.damagedQty > 0)
    if (status === "cancelled" && received) throw new ConvexError("Part of this purchase was already received — close it instead")
    if (!["draft", "ordered", "shipped", "cancelled", "received"].includes(status)) throw new ConvexError("Unknown status")
    if (status === "received" && !received) throw new ConvexError("Nothing received yet")
    const now = Date.now()
    await ctx.db.patch(id, {
      status, updatedAt: now,
      ...(status === "ordered" && !po.orderedAt ? { orderedAt: now } : {}),
      ...(status === "shipped" ? { shippedAt: po.shippedAt ?? now } : {}),
      ...(status === "received" ? { receivedAt: po.receivedAt ?? now } : {}),
      ...(tracking !== undefined ? { tracking } : {}),
    })
  },
})

/**
 * Receive goods against a PO (a GRN). Good units go to Available, damaged units to Damaged.
 * Purchase price becomes the weighted average, with shipping/other costs spread by value ("landed cost").
 */
export const receivePO = mutation({
  args: {
    id: v.id("purchaseOrders"),
    lines: v.array(v.object({ variantId: v.id("variants"), qty: v.number(), damaged: v.number() })),
    costMode: v.union(v.literal("average"), v.literal("latest"), v.literal("keep")),
    note: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const me = await requirePerm(ctx, "inventory.receive")
    const po = await ctx.db.get(a.id)
    if (!po) throw new ConvexError("Purchase not found")
    if (po.status === "cancelled" || po.status === "draft") throw new ConvexError("Mark the purchase as Ordered before receiving")
    const lines = a.lines.filter((l) => l.qty > 0 || l.damaged > 0)
    if (lines.length === 0) throw new ConvexError("Enter a received quantity for at least one product")

    // landed cost factor: extra costs spread over the order value
    const extra = po.shippingCost + po.otherCost - po.discount
    const factor = po.subtotal > 0 ? 1 + extra / po.subtotal : 1

    const code = await nextCounter(ctx, "receipt", 1)
    const items = po.items.map((i) => ({ ...i }))
    const grnItems: Doc<"receipts">["items"] = []
    for (const l of lines) {
      const it = items.find((i) => i.variantId === l.variantId)
      if (!it) throw new ConvexError("A product is not on this purchase")
      const remaining = it.orderedQty - it.receivedQty - it.damagedQty
      if (l.qty + l.damaged > remaining) throw new ConvexError(`${it.sku}: only ${remaining} left to receive`)
      it.receivedQty += l.qty
      it.damagedQty += l.damaged
      grnItems.push({ variantId: it.variantId, sku: it.sku, name: `${it.name} - ${it.title}`, qty: l.qty, damaged: l.damaged || undefined, unitCost: Math.round(it.unitCost * factor * 100) / 100 })
    }
    const receiptId = await ctx.db.insert("receipts", {
      code, locationId: po.locationId, poId: po._id, supplierId: po.supplierId, supplier: po.supplierName,
      note: a.note ?? `PO-${String(po.code).padStart(4, "0")}${po.supplierRef ? ` · ${po.supplierRef}` : ""}`,
      items: grnItems, totalQty: grnItems.reduce((s, i) => s + i.qty, 0),
      totalCost: grnItems.reduce((s, i) => s + (i.qty + (i.damaged ?? 0)) * i.unitCost, 0),
      byName: me.staff.name, at: Date.now(),
    })
    const poLabel = `PO-${String(po.code).padStart(4, "0")}`
    for (const g of grnItems) {
      const vr = await ctx.db.get(g.variantId)
      if (vr && a.costMode !== "keep" && g.qty > 0) {
        let newCost = g.unitCost
        if (a.costMode === "average") {
          const rows = await ctx.db.query("stock").withIndex("by_variant", (q) => q.eq("variantId", g.variantId)).collect()
          const onHand = rows.reduce((s, r) => s + Math.max(0, r.available) + r.processing + r.inTransit, 0)
          newCost = onHand > 0 && vr.purchasePrice > 0 ? (onHand * vr.purchasePrice + g.qty * g.unitCost) / (onHand + g.qty) : g.unitCost
        }
        await ctx.db.patch(g.variantId, { purchasePrice: Math.round(newCost * 100) / 100 })
      }
      if (g.qty > 0) await bumpStock(ctx, { variantId: g.variantId, locationId: po.locationId, bucket: "available", change: g.qty, reason: `Received ${poLabel} (GRN-${code})`, byName: me.staff.name, receiptId })
      if (g.damaged) await bumpStock(ctx, { variantId: g.variantId, locationId: po.locationId, bucket: "damaged", change: g.damaged, reason: `Arrived damaged ${poLabel} (GRN-${code})`, byName: me.staff.name, receiptId })
    }
    const done = items.every((i) => i.receivedQty + i.damagedQty >= i.orderedQty)
    await ctx.db.patch(po._id, { items, status: done ? "received" : "partial", updatedAt: Date.now(), ...(done ? { receivedAt: Date.now() } : {}) })
    return { code, receiptId }
  },
})

export const addSupplierPayment = mutation({
  args: { id: v.id("purchaseOrders"), amount: v.number(), method: v.string(), reference: v.optional(v.string()), note: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const me = await requirePerm(ctx, "purchases.pay")
    const po = await ctx.db.get(a.id)
    if (!po) throw new ConvexError("Purchase not found")
    if (a.amount <= 0) throw new ConvexError("Amount must be more than 0")
    await ctx.db.insert("supplierPayments", { poId: a.id, supplierId: po.supplierId, amount: a.amount, method: a.method, reference: a.reference, note: a.note, byName: me.staff.name, at: Date.now() })
    const paid = po.paid + a.amount
    await ctx.db.patch(a.id, { paid, due: Math.max(0, po.total - paid), updatedAt: Date.now() })
  },
})

// ---------------- Files (supplier invoice, packing list, photos) ----------------
export const uploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requirePerm(ctx, "purchases.manage")
    return await ctx.storage.generateUploadUrl()
  },
})

export const attachFile = mutation({
  args: { id: v.id("purchaseOrders"), storageId: v.id("_storage"), name: v.string(), type: v.string() },
  handler: async (ctx, a) => {
    await requirePerm(ctx, "purchases.manage")
    const po = await ctx.db.get(a.id)
    if (!po) throw new ConvexError("Purchase not found")
    await ctx.db.patch(a.id, { files: [...po.files, { storageId: a.storageId, name: a.name, type: a.type, at: Date.now() }] })
  },
})

export const removeFile = mutation({
  args: { id: v.id("purchaseOrders"), storageId: v.id("_storage") },
  handler: async (ctx, a) => {
    await requirePerm(ctx, "purchases.manage")
    const po = await ctx.db.get(a.id)
    if (!po) return
    await ctx.db.patch(a.id, { files: po.files.filter((f) => f.storageId !== a.storageId) })
    await ctx.storage.delete(a.storageId)
  },
})

// ---------------- Matching an uploaded supplier list ----------------
/** For each uploaded line, find the product by SKU, or by name + size. */
export const matchLines = query({
  args: { lines: v.array(v.object({ sku: v.optional(v.string()), name: v.optional(v.string()), size: v.optional(v.string()), color: v.optional(v.string()) })) },
  handler: async (ctx, { lines }) => {
    const s = await currentStaff(ctx)
    if (!s) return []
    const variants = await ctx.db.query("variants").collect()
    const products = new Map((await ctx.db.query("products").collect()).map((p) => [p._id as string, p]))
    const norm = (x?: string) => (x ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
    return lines.map((l) => {
      const sku = (l.sku ?? "").trim().toUpperCase()
      let vr = sku ? variants.find((x) => x.sku === sku) : undefined
      if (!vr && l.name) {
        const n = norm([l.name, l.color].filter(Boolean).join(" "))
        const size = norm(l.size)
        vr = variants.find((x) => {
          const p = products.get(x.productId)
          const pn = norm(p?.name)
          const fits = pn === n || pn.includes(n) || n.includes(pn)
          return fits && (!size || norm(x.title) === size || norm(x.title).endsWith(` ${size}`))
        })
      }
      if (!vr) return null
      const p = products.get(vr.productId)
      return { variantId: vr._id, sku: vr.sku, name: p?.name ?? "", title: vr.title, purchasePrice: vr.purchasePrice }
    })
  },
})

// ---------------- Product builder ----------------
/** Create one product with many sizes in one go (from the PO screen). Returns the new variants. */
export const createProductWithSizes = mutation({
  args: {
    name: v.string(),
    category: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
    price: v.number(),
    purchasePrice: v.number(),
    weightKg: v.number(),
    attrLabel: v.string(), // e.g. "Size"
    variants: v.array(v.object({ title: v.string(), sku: v.string() })),
  },
  handler: async (ctx, a) => {
    await requirePerm(ctx, "products.manage")
    if (!a.name.trim()) throw new ConvexError("Product name is required")
    if (a.variants.length === 0) throw new ConvexError("Add at least one size")
    const skus = a.variants.map((x) => x.sku.trim().toUpperCase())
    if (skus.some((x) => !x)) throw new ConvexError("Every size needs a SKU")
    if (new Set(skus).size !== skus.length) throw new ConvexError("SKUs must be unique")
    for (const sku of skus) {
      if (await ctx.db.query("variants").withIndex("by_sku", (q) => q.eq("sku", sku)).first()) throw new ConvexError(`SKU ${sku} already exists`)
    }
    const now = Date.now()
    let product = (await ctx.db.query("products").withSearchIndex("search_name", (q) => q.search("name", a.name.trim())).take(10)).find((p) => p.name === a.name.trim())
    const productId = product?._id ?? (await ctx.db.insert("products", { name: a.name.trim(), category: a.category, imageUrl: a.imageUrl, active: true, createdAt: now }))
    const out: { variantId: Id<"variants">; sku: string; title: string }[] = []
    for (let i = 0; i < a.variants.length; i++) {
      const title = a.variants[i].title.trim() || "Default"
      const variantId = await ctx.db.insert("variants", {
        productId, sku: skus[i], title, attrs: `${a.attrLabel}: ${title}`, weightKg: a.weightKg, price: a.price,
        purchasePrice: a.purchasePrice, imageUrl: a.imageUrl, active: true, createdAt: now,
      })
      out.push({ variantId, sku: skus[i], title })
    }
    return { productId, name: a.name.trim(), variants: out }
  },
})

export const categories = query({
  args: {},
  handler: async (ctx) => {
    const s = await currentStaff(ctx)
    if (!s) return []
    const set = new Set<string>()
    for (const p of await ctx.db.query("products").collect()) if (p.category) set.add(p.category)
    return [...set].sort()
  },
})

/** SKUs + quantities for printing barcode labels after a GRN. */
export const labelData = query({
  args: { receiptId: v.optional(v.id("receipts")), poId: v.optional(v.id("purchaseOrders")) },
  handler: async (ctx, { receiptId, poId }) => {
    const s = await currentStaff(ctx)
    if (!s) return null
    const rows: { sku: string; name: string; title: string; price: number; qty: number }[] = []
    const push = async (variantId: Id<"variants">, qty: number) => {
      const vr = await ctx.db.get(variantId)
      if (!vr || qty <= 0) return
      const p = await ctx.db.get(vr.productId)
      rows.push({ sku: vr.sku, name: p?.name ?? "", title: vr.title, price: vr.price, qty })
    }
    if (receiptId) {
      const r = await ctx.db.get(receiptId)
      for (const i of r?.items ?? []) await push(i.variantId, i.qty)
    } else if (poId) {
      const po = await ctx.db.get(poId)
      for (const i of po?.items ?? []) await push(i.variantId, i.receivedQty)
    }
    return rows
  },
})

// ---------------- Supplier summary (one view, date-wise) ----------------
/** Everything for a date range in one place: what we ordered (which shoes, how many pairs), what we paid, what we still owe. */
export const summary = query({
  args: { from: v.number(), to: v.number(), supplierId: v.optional(v.id("suppliers")) },
  handler: async (ctx, { from, to, supplierId }) => {
    const s = await currentStaff(ctx)
    if (!s) return null
    const code = (n: number) => `PO-${String(n).padStart(4, "0")}`
    const allPOs = supplierId
      ? await ctx.db.query("purchaseOrders").withIndex("by_supplier", (q) => q.eq("supplierId", supplierId)).collect()
      : await ctx.db.query("purchaseOrders").collect()
    const when = (p: Doc<"purchaseOrders">) => p.orderedAt ?? p.createdAt
    const pos = allPOs.filter((p) => p.status !== "cancelled" && when(p) >= from && when(p) <= to).sort((a, b) => when(b) - when(a))
    const allPays = supplierId
      ? await ctx.db.query("supplierPayments").withIndex("by_supplier", (q) => q.eq("supplierId", supplierId)).collect()
      : await ctx.db.query("supplierPayments").collect()
    const pays = allPays.filter((p) => p.at >= from && p.at <= to).sort((a, b) => b.at - a.at)
    const poById = new Map(allPOs.map((p) => [p._id as string, p]))
    const suppliers = supplierId ? [await ctx.db.get(supplierId)].filter(Boolean) as Doc<"suppliers">[] : await ctx.db.query("suppliers").collect()
    const nameOf = new Map(suppliers.map((sp) => [sp._id as string, sp.name]))

    // per product (base name), sizes listed
    const products = new Map<string, { name: string; ordered: number; received: number; value: number; sizes: Map<string, number> }>()
    for (const p of pos) for (const i of p.items) {
      const r = products.get(i.name) ?? { name: i.name, ordered: 0, received: 0, value: 0, sizes: new Map() }
      r.ordered += i.orderedQty; r.received += i.receivedQty; r.value += i.orderedQty * i.unitCost
      r.sizes.set(i.title, (r.sizes.get(i.title) ?? 0) + i.orderedQty)
      products.set(i.name, r)
    }

    // per supplier: in this period + what we owe now (all time)
    const bySupplier = await Promise.all(suppliers.map(async (sp) => {
      const mine = pos.filter((p) => p.supplierId === sp._id)
      const paidInRange = pays.filter((p) => p.supplierId === sp._id).reduce((t, p) => t + p.amount, 0)
      const acc = await supplierAccount(ctx, sp)
      return {
        _id: sp._id, name: sp.name, purchases: mine.length,
        pairs: mine.reduce((t, p) => t + p.items.reduce((u, i) => u + i.orderedQty, 0), 0),
        received: mine.reduce((t, p) => t + p.items.reduce((u, i) => u + i.receivedQty, 0), 0),
        value: mine.reduce((t, p) => t + p.total, 0),
        paid: paidInRange,
        dueNow: acc.due,
      }
    }))

    return {
      totals: {
        purchases: pos.length,
        pairs: pos.reduce((t, p) => t + p.items.reduce((u, i) => u + i.orderedQty, 0), 0),
        received: pos.reduce((t, p) => t + p.items.reduce((u, i) => u + i.receivedQty, 0), 0),
        value: pos.reduce((t, p) => t + p.total, 0),
        paid: pays.reduce((t, p) => t + p.amount, 0),
        dueNow: bySupplier.reduce((t, x) => t + Math.max(0, x.dueNow), 0),
      },
      suppliers: bySupplier.filter((x) => x.purchases > 0 || x.paid > 0 || x.dueNow !== 0).sort((a, b) => b.dueNow - a.dueNow),
      purchases: pos.map((p) => ({
        _id: p._id, code: code(p.code), at: when(p), status: p.status, supplier: p.supplierName, ref: p.supplierRef,
        lines: p.items.map((i) => ({ name: i.name, size: i.title, ordered: i.orderedQty, received: i.receivedQty, unitCost: i.unitCost })),
        pairs: p.items.reduce((t, i) => t + i.orderedQty, 0), received: p.items.reduce((t, i) => t + i.receivedQty, 0),
        total: p.total, paid: p.paid, due: p.status === "draft" ? 0 : p.due,
      })),
      payments: pays.map((p) => {
        const po = p.poId ? poById.get(p.poId) : undefined
        return { _id: p._id, at: p.at, supplier: (p.supplierId && nameOf.get(p.supplierId)) || po?.supplierName || "—", amount: p.amount, method: p.method, reference: p.reference, note: p.note, by: p.byName, po: po ? code(po.code) : null, poId: po?._id ?? null }
      }),
      products: [...products.values()].map((r) => ({ name: r.name, ordered: r.ordered, received: r.received, value: r.value, sizes: [...r.sizes.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true })).map(([k, n]) => `${k}: ${n}`).join(", ") })).sort((a, b) => b.ordered - a.ordered),
    }
  },
})
