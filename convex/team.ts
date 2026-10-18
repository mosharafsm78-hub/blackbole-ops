import { v, ConvexError } from "convex/values"
import { getAuthUserId } from "@convex-dev/auth/server"
import { mutation, query } from "./_generated/server"
import type { Id } from "./_generated/dataModel"
import { currentStaff, requirePerm } from "./lib"
import { DEFAULT_ROLES } from "./rules"

/** Access gate for the UI. Never throws. */
export const me = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx)
    if (!userId) return { kind: "signedOut" as const }
    const user = await ctx.db.get(userId)
    const s = await currentStaff(ctx)
    if (s) {
      const role = await ctx.db.get(s.staff.roleId)
      return {
        kind: "ok" as const,
        staff: { _id: s.staff._id, name: s.staff.name, email: s.staff.email },
        roleName: role?.name ?? "",
        perms: s.perms,
      }
    }
    const anyStaff = await ctx.db.query("staff").first()
    if (anyStaff) return { kind: "noAccess" as const, email: user?.email ?? "" }
    return { kind: "firstRun" as const, email: user?.email ?? "" }
  },
})

/** Called after sign-in: links an invited staff record, or makes the very first user the owner. */
export const claim = mutation({
  args: { name: v.optional(v.string()) },
  handler: async (ctx, { name }) => {
    const userId = await getAuthUserId(ctx)
    if (!userId) throw new ConvexError("Not signed in")
    const user = await ctx.db.get(userId)
    const email = (user?.email ?? "").toLowerCase()
    const linked = await ctx.db.query("staff").withIndex("by_user", (q) => q.eq("userId", userId)).unique()
    if (linked) return "ok"

    const invited = await ctx.db.query("staff").withIndex("by_email", (q) => q.eq("email", email)).unique()
    if (invited) {
      await ctx.db.patch(invited._id, { userId })
      return "ok"
    }

    const anyStaff = await ctx.db.query("staff").first()
    if (anyStaff) return "noAccess"

    // First run: create default roles, a default warehouse and make this user Super Admin.
    let adminRoleId: Id<"roles"> | null = null
    for (const r of DEFAULT_ROLES) {
      const id = await ctx.db.insert("roles", { name: r.name, permissions: r.permissions, system: r.name === "Super Admin" })
      if (r.name === "Super Admin") adminRoleId = id
    }
    const locs = await ctx.db.query("locations").first()
    if (!locs) {
      await ctx.db.insert("locations", { name: "BlackBole", address: "West Khulshi, Chattogram", active: true, isDefault: true })
      await ctx.db.insert("locations", { name: "BlackBole Dhaka", active: true })
    }
    await ctx.db.insert("staff", {
      email,
      name: name?.trim() || email.split("@")[0],
      roleId: adminRoleId!,
      userId,
      active: true,
      createdAt: Date.now(),
    })
    return "ok"
  },
})

export const listStaff = query({
  args: {},
  handler: async (ctx) => {
    await requirePerm(ctx, "team.manage")
    const staff = await ctx.db.query("staff").collect()
    const roles = await ctx.db.query("roles").collect()
    return staff.map((s) => ({
      ...s,
      roleName: roles.find((r) => r._id === s.roleId)?.name ?? "",
      joined: !!s.userId,
    }))
  },
})

export const saveStaff = mutation({
  args: {
    id: v.optional(v.id("staff")),
    email: v.string(),
    name: v.string(),
    phone: v.optional(v.string()),
    roleId: v.id("roles"),
    active: v.boolean(),
  },
  handler: async (ctx, a) => {
    const me = await requirePerm(ctx, "team.manage")
    const email = a.email.trim().toLowerCase()
    if (!email.includes("@")) throw new ConvexError("Enter a valid email")
    if (a.id) {
      if (a.id === me.staff._id && !a.active) throw new ConvexError("You can't deactivate yourself")
      await ctx.db.patch(a.id, { email, name: a.name, phone: a.phone, roleId: a.roleId, active: a.active })
      return a.id
    }
    const exists = await ctx.db.query("staff").withIndex("by_email", (q) => q.eq("email", email)).unique()
    if (exists) throw new ConvexError("This email is already on the team")
    // If this person already signed in once, link them now.
    const user = (await ctx.db.query("users").collect()).find((u) => (u.email ?? "").toLowerCase() === email)
    return await ctx.db.insert("staff", {
      email, name: a.name, phone: a.phone, roleId: a.roleId, active: a.active,
      userId: user?._id, createdAt: Date.now(),
    })
  },
})

export const listRoles = query({
  args: {},
  handler: async (ctx) => {
    const s = await currentStaff(ctx)
    if (!s) return []
    return await ctx.db.query("roles").collect()
  },
})

export const saveRole = mutation({
  args: { id: v.optional(v.id("roles")), name: v.string(), permissions: v.array(v.string()) },
  handler: async (ctx, a) => {
    await requirePerm(ctx, "team.manage")
    if (a.id) {
      const role = await ctx.db.get(a.id)
      if (role?.system) throw new ConvexError("Super Admin always has every permission")
      await ctx.db.patch(a.id, { name: a.name, permissions: a.permissions })
      return a.id
    }
    return await ctx.db.insert("roles", { name: a.name, permissions: a.permissions })
  },
})

export const listLocations = query({
  args: {},
  handler: async (ctx) => {
    const s = await currentStaff(ctx)
    if (!s) return []
    return await ctx.db.query("locations").collect()
  },
})

export const saveLocation = mutation({
  args: {
    id: v.optional(v.id("locations")),
    name: v.string(),
    address: v.optional(v.string()),
    phone: v.optional(v.string()),
    pathaoStoreId: v.optional(v.number()),
    isDefault: v.boolean(),
    active: v.boolean(),
  },
  handler: async (ctx, a) => {
    await requirePerm(ctx, "settings.manage")
    if (a.isDefault) {
      for (const l of await ctx.db.query("locations").collect()) {
        if (l.isDefault && l._id !== a.id) await ctx.db.patch(l._id, { isDefault: false })
      }
    }
    const data = { name: a.name, address: a.address, phone: a.phone, pathaoStoreId: a.pathaoStoreId, isDefault: a.isDefault, active: a.active }
    if (a.id) {
      await ctx.db.patch(a.id, data)
      return a.id
    }
    return await ctx.db.insert("locations", data)
  },
})
