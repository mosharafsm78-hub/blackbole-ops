import { v, ConvexError } from "convex/values"
import { mutation, query } from "./_generated/server"
import { currentStaff, getSetting, nextCounter, requirePerm } from "./lib"

export const list = query({
  args: { includeInactive: v.optional(v.boolean()) },
  handler: async (ctx, { includeInactive }) => {
    const s = await currentStaff(ctx)
    if (!s) return []
    const locs = await ctx.db.query("locations").collect()
    return (await ctx.db.query("deliveryPartners").collect())
      .filter((p) => !p.deletedAt && (includeInactive || p.active))
      .sort((a, b) => b.code - a.code)
      .map((p) => ({
        _id: p._id, code: p.code, name: p.name, provider: p.provider, contactPerson: p.contactPerson, phone: p.phone,
        locationId: p.locationId, locationName: locs.find((l) => l._id === p.locationId)?.name ?? "",
        pathaoStoreId: p.pathaoStoreId, useOwnCredentials: !!p.useOwnCredentials,
        credentialsHint: p.credentials ? `${p.credentials.env} · ${p.credentials.username}` : null,
        isExchange: !!p.isExchange, active: p.active, createdAt: p.createdAt,
      }))
  },
})

export const save = mutation({
  args: {
    id: v.optional(v.id("deliveryPartners")),
    name: v.string(),
    provider: v.string(),
    contactPerson: v.optional(v.string()),
    phone: v.optional(v.string()),
    locationId: v.optional(v.id("locations")),
    pathaoStoreId: v.optional(v.number()),
    isExchange: v.boolean(),
    active: v.boolean(),
    useOwnCredentials: v.boolean(),
    credentials: v.optional(v.object({
      env: v.union(v.literal("sandbox"), v.literal("production")),
      clientId: v.string(), clientSecret: v.string(), username: v.string(), password: v.string(),
    })),
  },
  handler: async (ctx, a) => {
    await requirePerm(ctx, "partners.manage")
    if (!a.name.trim()) throw new ConvexError("Name is required")
    const old = a.id ? await ctx.db.get(a.id) : null
    let credentials = old?.credentials
    if (a.useOwnCredentials && a.credentials) {
      credentials = {
        env: a.credentials.env,
        clientId: a.credentials.clientId.trim() || old?.credentials?.clientId,
        clientSecret: a.credentials.clientSecret.trim() || old?.credentials?.clientSecret,
        username: a.credentials.username.trim() || old?.credentials?.username,
        password: a.credentials.password || old?.credentials?.password,
      }
    }
    const data = {
      name: a.name.trim(), provider: a.provider, contactPerson: a.contactPerson, phone: a.phone, locationId: a.locationId,
      pathaoStoreId: a.pathaoStoreId, isExchange: a.isExchange, active: a.active, useOwnCredentials: a.useOwnCredentials,
      credentials: a.useOwnCredentials ? credentials : undefined,
    }
    if (a.id) {
      await ctx.db.patch(a.id, data)
      return a.id
    }
    const code = await nextCounter(ctx, "partner", 2001)
    return await ctx.db.insert("deliveryPartners", { ...data, code, createdAt: Date.now() })
  },
})

export const setActive = mutation({
  args: { id: v.id("deliveryPartners"), active: v.boolean() },
  handler: async (ctx, { id, active }) => {
    await requirePerm(ctx, "partners.manage")
    await ctx.db.patch(id, { active })
  },
})

export const remove = mutation({
  args: { id: v.id("deliveryPartners") },
  handler: async (ctx, { id }) => {
    await requirePerm(ctx, "partners.manage")
    await ctx.db.patch(id, { deletedAt: Date.now(), active: false })
  },
})

export const restore = mutation({
  args: { id: v.id("deliveryPartners") },
  handler: async (ctx, { id }) => {
    await requirePerm(ctx, "partners.manage")
    await ctx.db.patch(id, { deletedAt: undefined, active: true })
  },
})

export const listDeleted = query({
  args: {},
  handler: async (ctx) => {
    const s = await currentStaff(ctx)
    if (!s) return []
    return (await ctx.db.query("deliveryPartners").collect()).filter((p) => p.deletedAt)
  },
})

export const pathaoReady = query({
  args: {},
  handler: async (ctx) => {
    const s = await currentStaff(ctx)
    if (!s) return false
    return !!(await getSetting(ctx, "pathao"))
  },
})
