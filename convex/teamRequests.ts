// Requests between logged-in team members. Everyone has their own login, so a request always shows who asked whom,
// when, and what the answer was — instead of messages getting lost in chats.
import { v, ConvexError } from "convex/values"
import { query } from "./_generated/server"
import { mutation } from "./functions"
import type { Doc, Id } from "./_generated/dataModel"
import { currentStaff, invoiceLabel, logOrder } from "./lib"

export const KINDS = ["live_picture", "exchange", "question", "other"] as const
const MAX_PHOTOS = 6

async function me(ctx: any) {
  const s = await currentStaff(ctx)
  if (!s) throw new ConvexError("You are not signed in or your access was removed.")
  return s.staff as Doc<"staff">
}

async function view(ctx: any, r: Doc<"teamRequests">) {
  const urls = async (ids: Id<"_storage">[]) => (await Promise.all(ids.map((id) => ctx.storage.getUrl(id)))).filter(Boolean) as string[]
  const o = r.orderId ? await ctx.db.get(r.orderId) : null
  return {
    _id: r._id, kind: r.kind, status: r.status, fromStaffId: r.fromStaffId, fromName: r.fromName, toStaffId: r.toStaffId, toName: r.toName,
    orderId: r.orderId ?? null, invoice: o ? invoiceLabel(o) : null, customerName: o?.customerName ?? null,
    message: r.message, photos: await urls(r.photoIds), createdAt: r.createdAt, updatedAt: r.updatedAt, doneAt: r.doneAt ?? null, doneByName: r.doneByName ?? null,
    replies: await Promise.all(r.replies.map(async (x) => ({ byStaffId: x.byStaffId, byName: x.byName, text: x.text, photos: await urls(x.photoIds), at: x.at }))),
  }
}

export const uploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await me(ctx)
    return await ctx.storage.generateUploadUrl()
  },
})

/** Active team members a request can be sent to. */
export const people = query({
  args: {},
  handler: async (ctx) => {
    const s = await currentStaff(ctx)
    if (!s) return []
    const all = await ctx.db.query("staff").collect()
    const out: { _id: Id<"staff">; name: string; role: string }[] = []
    for (const x of all) {
      if (!x.active) continue
      const role = await ctx.db.get(x.roleId)
      out.push({ _id: x._id, name: x.name, role: role?.name ?? "" })
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  },
})

export const create = mutation({
  args: { kind: v.string(), toStaffId: v.id("staff"), message: v.string(), orderId: v.optional(v.id("orders")), photoIds: v.optional(v.array(v.id("_storage"))) },
  handler: async (ctx, a) => {
    const from = await me(ctx)
    if (!(KINDS as readonly string[]).includes(a.kind)) throw new ConvexError("Pick what kind of request this is.")
    const to = await ctx.db.get(a.toStaffId)
    if (!to || !to.active) throw new ConvexError("That person is not on the team any more.")
    if (to._id === from._id) throw new ConvexError("Pick someone else — a request to yourself would never be seen by anyone.")
    const message = a.message.trim()
    if (!message) throw new ConvexError("Write what you need.")
    if (message.length > 2000) throw new ConvexError("Please keep it under 2000 characters.")
    if ((a.photoIds ?? []).length > MAX_PHOTOS) throw new ConvexError(`You can attach up to ${MAX_PHOTOS} photos.`)
    let order: Doc<"orders"> | null = null
    if (a.orderId) {
      order = await ctx.db.get(a.orderId)
      if (!order) throw new ConvexError("Order not found.")
      // One open exchange request per order — stops the same exchange being raised (and shipped) twice.
      if (a.kind === "exchange") {
        const dup = (await ctx.db.query("teamRequests").withIndex("by_order", (q) => q.eq("orderId", a.orderId)).collect()).find((r) => r.kind === "exchange" && r.status !== "done")
        if (dup) throw new ConvexError(`An exchange request for ${invoiceLabel(order)} is already open (asked by ${dup.fromName} to ${dup.toName}). Add to that one instead of sending a second.`)
      }
    }
    const now = Date.now()
    const id = await ctx.db.insert("teamRequests", {
      kind: a.kind, fromStaffId: from._id, fromName: from.name, toStaffId: to._id, toName: to.name, orderId: a.orderId, message,
      photoIds: a.photoIds ?? [], status: "open", replies: [], createdAt: now, updatedAt: now,
    })
    if (order) await logOrder(ctx, order._id, `${from.name} asked ${to.name}: ${KIND_LABEL[a.kind]} — ${message.slice(0, 160)}`, from.name)
    return id
  },
})

export const reply = mutation({
  args: { id: v.id("teamRequests"), text: v.string(), photoIds: v.optional(v.array(v.id("_storage"))) },
  handler: async (ctx, a) => {
    const who = await me(ctx)
    const r = await ctx.db.get(a.id)
    if (!r) throw new ConvexError("Request not found.")
    if (r.status === "done") throw new ConvexError("This request is already closed.")
    if (who._id !== r.toStaffId && who._id !== r.fromStaffId) throw new ConvexError("Only the two people on this request can reply.")
    const text = a.text.trim()
    const photoIds = a.photoIds ?? []
    if (!text && photoIds.length === 0) throw new ConvexError("Write an answer or attach a photo.")
    if (photoIds.length > MAX_PHOTOS) throw new ConvexError(`You can attach up to ${MAX_PHOTOS} photos.`)
    const now = Date.now()
    // Answer from the person asked → waits for the asker. Message from the asker → back to the person asked.
    const status = who._id === r.toStaffId ? "answered" : "open"
    await ctx.db.patch(r._id, { replies: [...r.replies, { byStaffId: who._id, byName: who.name, text, photoIds, at: now }], status, updatedAt: now })
    if (r.orderId && status === "answered") {
      const o = await ctx.db.get(r.orderId)
      if (o) await logOrder(ctx, o._id, `${who.name} answered ${r.fromName}'s ${KIND_LABEL[r.kind]} request${photoIds.length ? " (with photo)" : ""}`, who.name)
    }
  },
})

/** Either person can close it once it is sorted out. */
export const close = mutation({
  args: { id: v.id("teamRequests") },
  handler: async (ctx, { id }) => {
    const who = await me(ctx)
    const r = await ctx.db.get(id)
    if (!r) throw new ConvexError("Request not found.")
    if (who._id !== r.toStaffId && who._id !== r.fromStaffId) throw new ConvexError("Only the two people on this request can close it.")
    if (r.status === "done") return
    await ctx.db.patch(id, { status: "done", doneAt: Date.now(), doneByName: who.name, updatedAt: Date.now() })
  },
})

/** scope: "toMe" (waiting for me to answer) | "fromMe" (I asked) | "open" (everyone's unfinished ones) | "done" */
export const list = query({
  args: { scope: v.string() },
  handler: async (ctx, { scope }) => {
    const s = await currentStaff(ctx)
    if (!s) return []
    const meId = s.staff._id
    let rows: Doc<"teamRequests">[] = []
    if (scope === "toMe") {
      const a = await ctx.db.query("teamRequests").withIndex("by_to_status", (q) => q.eq("toStaffId", meId)).order("desc").take(200)
      rows = a.filter((r) => r.status !== "done")
    } else if (scope === "fromMe") {
      rows = (await ctx.db.query("teamRequests").withIndex("by_from_status", (q) => q.eq("fromStaffId", meId)).order("desc").take(200)).filter((r) => r.status !== "done")
    } else if (scope === "open") {
      rows = [...(await ctx.db.query("teamRequests").withIndex("by_status", (q) => q.eq("status", "open")).collect()), ...(await ctx.db.query("teamRequests").withIndex("by_status", (q) => q.eq("status", "answered")).collect())]
    } else {
      rows = (await ctx.db.query("teamRequests").withIndex("by_status", (q) => q.eq("status", "done")).order("desc").take(100))
    }
    rows.sort((a, b) => b.updatedAt - a.updatedAt)
    return await Promise.all(rows.map((r) => view(ctx, r)))
  },
})

export const forOrder = query({
  args: { orderId: v.id("orders") },
  handler: async (ctx, { orderId }) => {
    const s = await currentStaff(ctx)
    if (!s) return []
    const rows = await ctx.db.query("teamRequests").withIndex("by_order", (q) => q.eq("orderId", orderId)).collect()
    rows.sort((a, b) => b.createdAt - a.createdAt)
    return await Promise.all(rows.map((r) => view(ctx, r)))
  },
})

/** Sidebar badge: things waiting on ME — requests to answer, plus answers I have not closed yet. */
export const myCounts = query({
  args: {},
  handler: async (ctx) => {
    const s = await currentStaff(ctx)
    if (!s) return { toAnswer: 0, answersIn: 0, total: 0 }
    const meId = s.staff._id
    const toAnswer = (await ctx.db.query("teamRequests").withIndex("by_to_status", (q) => q.eq("toStaffId", meId).eq("status", "open")).collect()).length
    const answersIn = (await ctx.db.query("teamRequests").withIndex("by_from_status", (q) => q.eq("fromStaffId", meId).eq("status", "answered")).collect()).length
    return { toAnswer, answersIn, total: toAnswer + answersIn }
  },
})

export const KIND_LABEL: Record<string, string> = { live_picture: "Live picture", exchange: "Exchange", question: "Question", other: "Request" }
