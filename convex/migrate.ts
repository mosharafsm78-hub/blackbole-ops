import { v } from "convex/values"
import { paginationOptsValidator } from "convex/server"
import { action, httpAction, internalMutation, internalQuery, mutation } from "./_generated/server"
import { internal } from "./_generated/api"
import type { Doc, Id } from "./_generated/dataModel"
import { getSetting, moveOrderStock, nextCounter, requirePerm, setCounter, setSetting } from "./lib"
import { bumpStatusCount } from "./orders"
import { STATUS_TABS } from "./rules"

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
}
const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "Content-Type": "application/json", ...cors } })

export const setKey = internalMutation({
  args: { key: v.union(v.string(), v.null()) },
  handler: async (ctx, { key }) => setSetting(ctx, "migrateKey", key),
})

export const keyOk = internalQuery({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    const envKey = process.env.MIGRATE_KEY
    if (envKey && envKey.length > 20 && envKey === key) return true
    const k = await getSetting<string>(ctx, "migrateKey")
    return !!k && k.length > 20 && k === key
  },
})

/** Admin only: create a one-time import key (used by the Data import page). */
export const issueKey = mutation({
  args: {},
  handler: async (ctx) => {
    await requirePerm(ctx, "team.manage")
    const arr = new Uint32Array(40)
    crypto.getRandomValues(arr)
    const key = Array.from(arr, (n) => "abcdefghijklmnopqrstuvwxyz0123456789"[n % 36]).join("")
    await setSetting(ctx, "migrateKey", key)
    return { key, url: `${process.env.CONVEX_SITE_URL}/migrate` }
  },
})

/** Admin only: switch the import endpoint off again. */
export const clearKey = mutation({
  args: {},
  handler: async (ctx) => {
    await requirePerm(ctx, "team.manage")
    await setSetting(ctx, "migrateKey", null)
  },
})

// ---------- setup ----------
export const setup = internalMutation({
  args: {},
  handler: async (ctx) => {
    const locs = await ctx.db.query("locations").collect()
    const ensureLoc = async (name: string, address: string, isDefault: boolean, aliases: string[]) => {
      const found = locs.find((l) => [name, ...aliases].includes(l.name))
      if (found) {
        await ctx.db.patch(found._id, { name, address: found.address ?? address, isDefault })
        return found._id
      }
      return await ctx.db.insert("locations", { name, address, isDefault, active: true })
    }
    const ctg = await ensureLoc("BlackBole", "West Khulshi, Chattogram", true, ["BlackBole Chattogram"])
    const dhk = await ensureLoc("BlackBole Dhaka", "Matuail Medical, Adorsh Nagar, Badam Tola, Khamar Bari", false, [])
    const partners = await ctx.db.query("deliveryPartners").collect()
    const defs = [
      { code: 2330, name: "Pathao Ctg", provider: "pathao", locationId: ctg, isExchange: false, contactPerson: "Saju Das" },
      { code: 2390, name: "Pathao Dhaka", provider: "pathao", locationId: dhk, isExchange: false, contactPerson: "Bito" },
      { code: 2391, name: "Pathao Exchange CTG", provider: "pathao", locationId: ctg, isExchange: true, contactPerson: "Saju Das" },
      { code: 2392, name: "Pathao Exchange Dhaka", provider: "pathao", locationId: dhk, isExchange: true, contactPerson: "Bito" },
      { code: 2778, name: "Daraz Dhk", provider: "custom", locationId: dhk, isExchange: false, contactPerson: "Bito" },
    ]
    for (const d of defs) {
      if (partners.some((p) => p.name === d.name)) continue
      await ctx.db.insert("deliveryPartners", { ...d, active: true, createdAt: Date.now() })
    }
    await setCounter(ctx, "partner", 2778)
    return { ctg, dhk }
  },
})

// ---------- products ----------
export const products = internalMutation({
  args: { rows: v.array(v.any()) },
  handler: async (ctx, { rows }) => {
    const num = (s: string) => Number(String(s ?? "").replace(/[^\d.]/g, "")) || 0
    const strip = (n: string) => String(n ?? "").replace(/\s+(Variant|Base Product)$/, "").trim()
    const bases = rows.filter((r) => /Base Product$/.test(r.name)).map((r) => strip(r.name)).sort((a, b) => b.length - a.length)
    let created = 0, updated = 0
    const productIds = new Map<string, Id<"products">>()
    const existingProducts = await ctx.db.query("products").collect()
    const getProduct = async (name: string, r: any) => {
      if (productIds.has(name)) return productIds.get(name)!
      const found = existingProducts.find((p) => p.name === name)
      const id = found?._id ?? (await ctx.db.insert("products", {
        name, category: r.cat || undefined, imageUrl: r.img || undefined, active: r.status !== "Inactive", createdAt: Date.now(),
      }))
      if (found && !found.imageUrl && r.img) await ctx.db.patch(found._id, { imageUrl: r.img })
      productIds.set(name, id)
      return id
    }
    for (const r of rows) {
      const name = strip(r.name)
      if (/Base Product$/.test(r.name)) { await getProduct(name, r); continue }
      const sku = String(r.sku ?? "").trim().toUpperCase()
      if (!sku || sku === "NO SKU") continue
      const base = bases.find((b) => name.startsWith(b + " - ") || name === b) ?? name.replace(/\s+-\s+[^-]+$/, "")
      const pid = await getProduct(base, r)
      const title = String(r.attr ?? "").replace(/^[^:]+:\s*/, "").trim() || name.slice(base.length).replace(/^\s*-\s*/, "") || "Default"
      const data = {
        productId: pid, sku, title, attrs: r.attr || undefined, weightKg: num(r.spec), price: num(r.mrp),
        purchasePrice: num(r.cost), distributorPrice: num(r.dist), retailerPrice: num(r.ret),
        imageUrl: r.img || undefined, active: r.status !== "Inactive",
      }
      const existing = await ctx.db.query("variants").withIndex("by_sku", (q) => q.eq("sku", sku)).first()
      if (existing) { await ctx.db.patch(existing._id, data); updated++ } else { await ctx.db.insert("variants", { ...data, createdAt: Date.now() }); created++ }
    }
    return { created, updated }
  },
})

// ---------- stock snapshot ----------
export const stock = internalMutation({
  args: { rows: v.array(v.object({ sku: v.string(), name: v.optional(v.string()), location: v.string(), available: v.number(), processing: v.number(), inTransit: v.number(), returning: v.number(), shortage: v.number(), wastage: v.number(), expired: v.number() })) },
  handler: async (ctx, { rows }) => {
    const locs = await ctx.db.query("locations").collect()
    let set = 0
    const missing: string[] = []
    for (const r of rows) {
      const loc = locs.find((l) => l.name.trim().toLowerCase() === r.location.trim().toLowerCase())
      let vr = await ctx.db.query("variants").withIndex("by_sku", (q) => q.eq("sku", r.sku.trim().toUpperCase())).first()
      if (!vr && r.name) {
        // stock row for a SKU missing from the product list: create a minimal product
        const pid = await ctx.db.insert("products", { name: r.name.replace(/\s+-\s+[^-]+$/, ""), active: true, createdAt: Date.now() })
        const id = await ctx.db.insert("variants", { productId: pid, sku: r.sku.trim().toUpperCase(), title: r.name.split(" - ").pop() ?? "Default", weightKg: 0.5, price: 0, purchasePrice: 0, active: true, createdAt: Date.now() })
        vr = await ctx.db.get(id)
      }
      if (!loc || !vr) { missing.push(r.sku); continue }
      const existing = await ctx.db.query("stock").withIndex("by_variant_location", (q) => q.eq("variantId", vr!._id).eq("locationId", loc._id)).unique()
      const data = {
        variantId: vr._id, locationId: loc._id, available: r.available - r.shortage, processing: r.processing,
        inTransit: r.inTransit, returning: r.returning, damaged: 0, wastage: r.wastage, expired: r.expired,
      }
      if (existing) await ctx.db.patch(existing._id, data)
      else await ctx.db.insert("stock", data)
      await ctx.db.insert("stockLogs", { variantId: vr._id, locationId: loc._id, bucket: "available", change: data.available, reason: "Opening stock imported from Nuport", byName: "Import", at: Date.now() })
      set++
    }
    return { set, missing }
  },
})

// ---------- customers ----------
export const customers = internalMutation({
  args: { rows: v.array(v.any()) },
  handler: async (ctx, { rows }) => {
    let created = 0, updated = 0
    for (const c of rows) {
      const existing = await ctx.db.query("customers").withIndex("by_phone", (q) => q.eq("phone", c.phone)).unique()
      const data = {
        name: c.name || "Customer", phone: c.phone, email: c.email || undefined, address: c.address || undefined, city: c.city || undefined,
        tag: c.tag || "NEW", source: c.source || undefined, orderCount: c.orderCount, deliveredCount: c.deliveredCount,
        returnedCount: c.returnedCount, cancelledCount: c.cancelledCount, totalSpent: c.totalSpent, lastOrderAt: c.lastOrderAt,
        customerType: "E-Commerce Customer", smsCount: 0, createdAt: c.createdAt,
      }
      if (existing) { await ctx.db.patch(existing._id, data); updated++ }
      else { await ctx.db.insert("customers", { ...data, code: c.code }); created++ }
    }
    return { created, updated }
  },
})

// ---------- orders ----------
type ImportCtx = { locs: Doc<"locations">[]; partners: Doc<"deliveryPartners">[]; variant: (sku: string) => Promise<Doc<"variants"> | null> }
export async function importCtx(ctx: any): Promise<ImportCtx> {
  const locs = await ctx.db.query("locations").collect()
  const partners = await ctx.db.query("deliveryPartners").collect()
  const cache = new Map<string, Doc<"variants"> | null>()
  const variant = async (sku: string) => {
    if (!cache.has(sku)) cache.set(sku, await ctx.db.query("variants").withIndex("by_sku", (q: any) => q.eq("sku", sku)).first())
    return cache.get(sku)!
  }
  return { locs, partners, variant }
}

/** Builds the item list of a Nuport order (prices, SKUs, weights) and its purchase cost. */
export async function importItems(ic: ImportCtx, rows: any[]) {
  const items: Doc<"orders">["items"] = []
  let purchaseCost = 0
  for (const i of rows) {
    const vr = await ic.variant(i.sku)
    if (vr) purchaseCost += vr.purchasePrice * i.qty
    items.push({ variantId: vr?._id, sku: i.sku, name: i.name, attrs: i.attrs || undefined, imageUrl: vr?.imageUrl, price: i.price, qty: i.qty, discount: i.discount, weightKg: i.weightKg ?? vr?.weightKg ?? 0.5 })
  }
  return { items, purchaseCost }
}

/** Inserts one order exactly as Nuport has it (customer must already exist). */
export async function insertNuportOrder(ctx: any, ic: ImportCtx, o: any, customerId: Id<"customers">, note = "imported from Nuport"): Promise<Id<"orders">> {
  const loc = ic.locs.find((l) => l.name.toLowerCase() === String(o.location).toLowerCase()) ?? ic.locs.find((l) => l.isDefault) ?? ic.locs[0]
  const partner = ic.partners.find((p) => p.name.toLowerCase() === String(o.partner ?? "").toLowerCase())
  const { items, purchaseCost } = await importItems(ic, o.items)
  const delivered = o.status === "delivered_paid" || o.status === "delivered_due"
  const shipped = !!o.consignmentId
  const id = await ctx.db.insert("orders", {
    invoiceNo: o.invoiceNo, invoiceCode: o.invoiceCode || undefined, status: o.status, source: o.source,
    externalId: undefined, externalName: o.websiteOrderId ? `#${o.websiteOrderId}` : undefined,
    customerId, customerName: o.customerName, phone: o.phone, address: o.address, cityName: o.city || undefined,
    areaName: o.area || undefined, locationId: loc._id, deliveryType: o.deliveryType || "regular", items,
    subtotal: o.subtotal, discount: o.discount, deliveryFee: o.deliveryFee, paidAmount: o.paid, total: o.total, due: o.due,
    paymentMethod: o.paymentMethod, courier: partner?.provider === "pathao" ? "pathao" : partner ? "manual" : "pickup",
    deliveryPartnerId: partner?._id, deliveryPartnerName: partner?.name ?? o.partner, consignmentId: o.consignmentId || undefined,
    courierStatus: o.partnerStatus || undefined, courierFee: shipped ? o.deliveryFee : undefined, customerNote: undefined,
    additionalInfo: o.additionalNote || undefined, callCount: 0, printedAt: undefined,
    shippingDate: o.shippingDate || undefined, createdByName: o.entryBy || "Import", createdAt: o.createdAt,
    updatedAt: o.deliveredAt || o.shippedAt || o.createdAt, statusChangedAt: o.deliveredAt || o.shippedAt || o.shippingDate || o.createdAt,
    reason: o.reason || undefined, shippedAt: o.shippedAt || undefined, deliveredAt: delivered ? (o.deliveredAt || o.shippedAt || o.createdAt) : undefined,
    approvedAt: ["pending", "on_hold", "cancelled"].includes(o.status) ? undefined : (o.shippingDate || o.createdAt),
    isExchange: o.isExchange || undefined, ipAddress: o.ip || undefined, origin: o.origin || undefined, campaignId: o.campaignId || undefined,
    noteCount: o.notes ? 1 : 0, itemCount: items.reduce((s, i) => s + i.qty, 0), hasUpsell: o.source === "Up Sell" || undefined,
    returnedQty: o.returnedQty || undefined, purchaseCost,
    codCost: delivered ? Math.round(o.collected * 1) / 100 : undefined, courierCost: shipped ? o.deliveryFee : undefined,
    imported: true,
  })
  await ctx.db.insert("orderEvents", { orderId: id, type: "log", text: `Order created by ${o.entryBy || "Import"} from ${o.source} (${note})`, byName: o.entryBy || "Import", at: o.createdAt })
  if (o.notes) await ctx.db.insert("orderEvents", { orderId: id, type: "note", text: o.notes, byName: o.entryBy || "Import", at: o.createdAt })
  if (o.paid > 0) await ctx.db.insert("payments", { orderId: id, method: o.paymentMethod, amount: o.paid, reference: o.consignmentId || undefined, byName: "Import", at: o.deliveredAt || o.createdAt })
  return id
}

export const orders = internalMutation({
  args: { rows: v.array(v.any()) },
  handler: async (ctx, { rows }) => {
    const ic = await importCtx(ctx)
    let created = 0, skipped = 0
    for (const o of rows) {
      const dupe = o.invoiceCode
        ? await ctx.db.query("orders").withIndex("by_invoice_code", (q) => q.eq("invoiceCode", o.invoiceCode)).first()
        : await ctx.db.query("orders").withIndex("by_invoice", (q) => q.eq("invoiceNo", o.invoiceNo)).first()
      if (dupe) { skipped++; continue }
      const customer = await ctx.db.query("customers").withIndex("by_phone", (q) => q.eq("phone", o.phone)).unique()
      if (!customer) { skipped++; continue }
      await insertNuportOrder(ctx, ic, o, customer._id)
      created++
    }
    return { created, skipped }
  },
})

// ---------- finalize counters ----------
export const countPage = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    const res = await ctx.db.query("orders").paginate(paginationOpts)
    const counts: Record<string, number> = {}
    let maxInvoice = 0
    for (const o of res.page) {
      if (!o.deletedAt) counts[o.status] = (counts[o.status] ?? 0) + 1
      if (o.invoiceNo > maxInvoice) maxInvoice = o.invoiceNo
    }
    return { counts, maxInvoice, isDone: res.isDone, cursor: res.continueCursor }
  },
})

export const writeCounters = internalMutation({
  args: { counts: v.any(), maxInvoice: v.number() },
  handler: async (ctx, { counts, maxInvoice }) => {
    for (const tab of STATUS_TABS) for (const st of tab.statuses) await setCounter(ctx, `st:${st}`, counts[st] ?? 0)
    const inv = await ctx.db.query("counters").withIndex("by_name", (q) => q.eq("name", "invoice")).unique()
    if (!inv || inv.value < maxInvoice) await setCounter(ctx, "invoice", maxInvoice)
    const customers = await ctx.db.query("customers").collect()
    await setCounter(ctx, "customer", Math.max(10000, ...customers.map((c) => c.code)))
    return { customers: customers.length }
  },
})

export const handler = httpAction(async (ctx, req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors })
  const body: any = await req.json().catch(() => null)
  if (!body?.key || !(await ctx.runQuery(internal.migrate.keyOk, { key: body.key }))) return json({ error: "bad key" }, 401)
  try {
    switch (body.kind) {
      case "setup": return json(await ctx.runMutation(internal.migrate.setup, {}))
      case "products": return json(await ctx.runMutation(internal.migrate.products, { rows: body.rows }))
      case "stock": return json(await ctx.runMutation(internal.migrate.stock, { rows: body.rows }))
      case "customers": return json(await ctx.runMutation(internal.migrate.customers, { rows: body.rows }))
      case "orders": return json(await ctx.runMutation(internal.migrate.orders, { rows: body.rows }))
      case "finalize": {
        const counts: Record<string, number> = {}
        let maxInvoice = 0
        let cursor: string | null = null
        for (;;) {
          const r: any = await ctx.runQuery(internal.migrate.countPage, { paginationOpts: { numItems: 1000, cursor } })
          for (const [k, n] of Object.entries(r.counts)) counts[k] = (counts[k] ?? 0) + (n as number)
          maxInvoice = Math.max(maxInvoice, r.maxInvoice)
          if (r.isDone) break
          cursor = r.cursor
        }
        const res = await ctx.runMutation(internal.migrate.writeCounters, { counts, maxInvoice })
        return json({ counts, maxInvoice, ...res })
      }
      case "nuportSync": return json(await nuportSync(ctx, body.rows ?? []))
      default: return json({ error: "unknown kind" }, 400)
    }
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})

type NuRow = { inv: string; shopify?: string | null; phone?: string | null; cid?: string | null; status: string; nuport: string }
const normPhone = (p?: string | null) => { const d = String(p ?? "").replace(/\D/g, ""); return d.startsWith("880") ? `0${d.slice(3)}` : d.startsWith("88") && d.length === 13 ? d.slice(2) : d }

const GROUP: Record<string, string[]> = {
  delivered: ["delivered_due", "delivered_paid"],
  flagged: ["pending_returned", "returned", "damaged"],
}

/**
 * Takes Nuport's current status for a list of orders and makes ours the same (matched by consignment, Shopify number,
 * or invoice + phone). Also gives our orders the same invoice numbers as Nuport (numbers drift because Nuport also numbers
 * abandoned checkouts and manual orders). Status "keep" = only match and renumber; "delivered"/"flagged" = report if ours
 * is not in that group.
 */
async function nuportSync(ctx: any, rows: NuRow[], dryRun = false) {
  const from = Date.now() - 150 * 86400000
  const ours: { id: string; no: number; code: string | null; ext: string | null; phone: string; status: string; cid: string | null }[] = []
  let cursor: string | null = null
  for (let i = 0; i < 50; i++) {
    const r: any = await ctx.runQuery(internal.orders.nuportIndexPage, { from, cursor })
    ours.push(...r.rows)
    if (r.isDone) break
    cursor = r.cursor
  }
  const byCid = new Map(ours.filter((o) => o.cid).map((o) => [o.cid!, o]))
  const byExt = new Map(ours.filter((o) => o.ext && !o.code).map((o) => [o.ext!.replace(/\D/g, ""), o]))
  const byNo = new Map(ours.map((o) => [o.code ?? `BB-${o.no}`, o]))
  const apply: { id: string; to: string; cid?: string; nuport: string }[] = []
  const renames: { id: string; from: number; to: number }[] = []
  const groupMismatch: string[] = []
  const unmatched: string[] = []
  let same = 0
  const seen = new Set<string>()
  for (const r of rows) {
    const phone = normPhone(r.phone)
    const plain = /^BB-(\d+)$/.exec(r.inv)
    const cid = r.cid && /^DB/.test(r.cid) ? r.cid : null // only delivery parcels (RB/RE are returns, EB exchanges)
    let o = plain ? (cid && byCid.get(cid)) || (r.shopify && byExt.get(String(r.shopify).replace(/\D/g, ""))) || undefined : undefined
    if (!o) {
      // Invoice numbers drifted between Nuport and this app for newer orders, so an invoice match must be confirmed
      const c = byNo.get(r.inv)
      const shopOk = r.shopify && c?.ext ? c.ext.replace(/\D/g, "") === String(r.shopify).replace(/\D/g, "") : null
      const phoneOk = phone && c ? c.phone === phone : null
      if (c && shopOk !== false && phoneOk !== false && (shopOk || phoneOk)) o = c
    }
    if (!o) { unmatched.push(r.inv); continue }
    if (seen.has(o.id)) continue
    seen.add(o.id)
    if (plain && !o.code && o.no !== Number(plain[1])) renames.push({ id: o.id, from: o.no, to: Number(plain[1]) })
    if (r.status === "keep") { same++; continue }
    if (GROUP[r.status]) {
      if (GROUP[r.status].includes(o.status)) same++
      else groupMismatch.push(`${r.inv}: Nuport ${r.nuport}, here ${o.status}`)
      continue
    }
    if (o.status === r.status && (!cid || o.cid)) { same++; continue }
    apply.push({ id: o.id, to: r.status, cid: cid ?? undefined, nuport: r.nuport })
  }
  let changed = 0, linked = 0
  const errors: string[] = []
  for (let i = 0; i < (dryRun ? 0 : apply.length); i += 40) {
    const res: any = await ctx.runMutation(internal.orders.nuportApply, { rows: apply.slice(i, i + 40) })
    changed += res.changed; linked += res.linked; errors.push(...res.errors)
  }
  // Same invoice numbers as Nuport. Any order of ours that would end up sharing a number (one Nuport doesn't have)
  // moves to a fresh number above everything.
  const renamed = new Map(renames.map((x) => [x.id, x.to]))
  const finalNo = (o: (typeof ours)[number]) => renamed.get(o.id) ?? o.no
  const taken = new Map<number, string[]>()
  for (const o of ours) if (!o.code) { const n = finalNo(o); taken.set(n, [...(taken.get(n) ?? []), o.id]) }
  let top = Math.max(0, ...ours.map((o) => o.no), ...renames.map((x) => x.to), ...rows.map((r) => Number(/^BB-(\d+)$/.exec(r.inv)?.[1] ?? 0)))
  const moved: { id: string; from: number; to: number }[] = []
  for (const [n, ids] of taken) {
    if (ids.length < 2) continue
    for (const id of ids) {
      if (renamed.has(id) || seen.has(id)) continue // matched to Nuport: keeps Nuport's number
      const o = ours.find((x) => x.id === id)!
      moved.push({ id, from: o.no, to: ++top })
    }
  }
  const allRenames = [...renames, ...moved]
  if (dryRun) {
    const label = (id: string) => { const o = ours.find((x) => x.id === id)!; return o.code ?? `BB-${o.no}` }
    return {
      dryRun: true, received: rows.length, alreadySame: same, unmatched, groupMismatch, movedAside: moved.map((m) => `BB-${m.from} → BB-${m.to}`),
      statusChanges: apply.map((a) => `${label(a.id)} ${ours.find((x) => x.id === a.id)!.status} → ${a.to}${a.cid ? ` +${a.cid}` : ""}`),
      renames: renames.map((r) => `BB-${r.from} → BB-${r.to}`), top,
    }
  }
  for (let i = 0; i < allRenames.length; i += 50) await ctx.runMutation(internal.orders.nuportRenumber, { rows: allRenames.slice(i, i + 50), top })
  if (!allRenames.length) await ctx.runMutation(internal.orders.nuportRenumber, { rows: [], top })
  const OPEN = ["pending", "on_hold", "approved", "processing", "ready_to_ship", "in_transit"]
  const notSeen = ours.filter((o) => OPEN.includes(o.status) && !seen.has(o.id)).map((o) => ({ inv: o.code ?? `BB-${finalNo(o)}`, ext: o.ext, status: o.status }))
  return {
    received: rows.length, alreadySame: same, changed, linked, unmatched, errors, notSeen, groupMismatch,
    renumbered: renames.length, movedAside: moved.map((m) => `BB-${m.from} → BB-${m.to}`),
  }
}

/** Same Nuport status sync, run from the Data import page by an admin (no import key needed). */
export const nuportSyncNow = action({
  args: { rows: v.array(v.object({ inv: v.string(), shopify: v.optional(v.union(v.string(), v.null())), phone: v.optional(v.union(v.string(), v.null())), cid: v.optional(v.union(v.string(), v.null())), status: v.string(), nuport: v.string() })), dryRun: v.optional(v.boolean()) },
  handler: async (ctx, { rows, dryRun }): Promise<any> => {
    await ctx.runQuery(internal.pathao.checkPerm, { perm: "team.manage" })
    const allowed = new Set(["keep", "delivered", "flagged", "pending", "on_hold", "approved", "processing", "ready_to_ship", "in_transit", "delivered_due", "delivered_paid", "pending_returned", "returned", "damaged", "cancelled"])
    return await nuportSync(ctx, rows.filter((r) => allowed.has(r.status)) as NuRow[], !!dryRun)
  },
})

/** Adds orders that exist only in Nuport (manual orders, abandoned-checkout orders) with Nuport's own invoice number. */
export const nuportCreateOrders = mutation({
  args: { rows: v.array(v.any()) },
  handler: async (ctx, { rows }) => {
    const me = await requirePerm(ctx, "team.manage")
    const ic = await importCtx(ctx)
    const created: string[] = []
    const skipped: string[] = []
    for (const o of rows) {
      const label = o.invoiceCode || `BB-${o.invoiceNo}`
      const dupe = o.invoiceCode
        ? await ctx.db.query("orders").withIndex("by_invoice_code", (q) => q.eq("invoiceCode", o.invoiceCode)).first()
        : await ctx.db.query("orders").withIndex("by_invoice", (q) => q.eq("invoiceNo", o.invoiceNo)).filter((q) => q.eq(q.field("deletedAt"), undefined)).first()
      if (dupe) { skipped.push(`${label} (number already used)`); continue }
      let customer = await ctx.db.query("customers").withIndex("by_phone", (q) => q.eq("phone", o.phone)).unique()
      if (!customer) {
        const code = await nextCounter(ctx, "customer", 10001)
        const cid = await ctx.db.insert("customers", {
          code, name: o.customerName || "Customer", phone: o.phone, address: o.address || undefined, city: o.city || undefined,
          tag: "NEW", source: o.source, orderCount: 0, deliveredCount: 0, returnedCount: 0, cancelledCount: 0, totalSpent: 0,
          customerType: "E-Commerce Customer", smsCount: 0, createdAt: o.createdAt,
        })
        customer = (await ctx.db.get(cid))!
      }
      await ctx.db.patch(customer._id, { orderCount: customer.orderCount + 1, lastOrderAt: Math.max(customer.lastOrderAt ?? 0, o.createdAt) })
      const id: Id<"orders"> = await insertNuportOrder(ctx, ic, o, customer._id, "copied from Nuport — it was made there")
      const order = (await ctx.db.get(id))!
      await moveOrderStock(ctx, order, "cancelled", o.status, me.staff.name) // take the pairs out of free stock like a normal order
      await bumpStatusCount(ctx, o.status, 1)
      created.push(label)
    }
    const top = Math.max(0, ...rows.map((o: any) => Number(o.invoiceNo) || 0))
    const inv = await ctx.db.query("counters").withIndex("by_name", (q) => q.eq("name", "invoice")).unique()
    if (inv && inv.value < top) await ctx.db.patch(inv._id, { value: top })
    return { created, skipped }
  },
})
