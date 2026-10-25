import { v, ConvexError } from "convex/values"
import { getAuthUserId } from "@convex-dev/auth/server"
import { query, type MutationCtx } from "./_generated/server"
import { internalMutation, mutation } from "./functions"
import type { Id } from "./_generated/dataModel"
import { currentStaff, effectivePerms, requirePerm } from "./lib"
import { DEFAULT_ROLES, PERMISSIONS, ALL_MOVE_KEYS } from "./rules"

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
    if (!anyStaff) return { kind: "firstRun" as const, email: user?.email ?? "" }
    const linked = await ctx.db.query("staff").withIndex("by_user", (q) => q.eq("userId", userId)).unique()
    if (linked && !linked.active) return { kind: "disabled" as const, email: user?.email ?? "" }
    const req = await ctx.db.query("accessRequests").withIndex("by_user", (q) => q.eq("userId", userId)).unique()
    if (req?.status === "waiting") return { kind: "waiting" as const, email: user?.email ?? "", name: req.name ?? "" }
    if (req?.status === "rejected") return { kind: "rejected" as const, email: user?.email ?? "" }
    return { kind: "noAccess" as const, email: user?.email ?? "" }
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

    const invited = (await ctx.db.query("staff").withIndex("by_email", (q) => q.eq("email", email)).unique())
      ?? (await ctx.db.query("staff").collect()).find((x) => x.email.toLowerCase() === email && !x.userId) ?? null
    if (invited) {
      await ctx.db.patch(invited._id, { userId })
      return "ok"
    }

    const anyStaff = await ctx.db.query("staff").first()
    if (anyStaff) {
      // Not invited: ask an admin for access
      const req = await ctx.db.query("accessRequests").withIndex("by_user", (q) => q.eq("userId", userId)).unique()
      if (!req) await ctx.db.insert("accessRequests", { userId, email, name: name?.trim() || undefined, status: "waiting", at: Date.now() })
      else if (req.status === "waiting" && name?.trim()) await ctx.db.patch(req._id, { name: name.trim() })
      return "waiting"
    }

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
    return staff.map((s) => {
      const role = roles.find((r) => r._id === s.roleId)
      return {
        ...s,
        roleName: role?.name ?? "",
        rolePerms: role?.permissions ?? [],
        isSuperAdmin: !!role?.permissions.includes("*"),
        perms: effectivePerms(role?.permissions ?? [], s),
        joined: !!s.userId,
      }
    })
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
    noCourier: v.optional(v.boolean()),
  },
  handler: async (ctx, a) => {
    await requirePerm(ctx, "settings.manage")
    if (a.noCourier && a.isDefault) throw new ConvexError("An exchange warehouse can't be the default warehouse")
    if (a.isDefault) {
      for (const l of await ctx.db.query("locations").collect()) {
        if (l.isDefault && l._id !== a.id) await ctx.db.patch(l._id, { isDefault: false })
      }
    }
    const data = { name: a.name, address: a.address, phone: a.phone, pathaoStoreId: a.noCourier ? undefined : a.pathaoStoreId, isDefault: a.isDefault, active: a.active, noCourier: a.noCourier || undefined }
    if (a.id) {
      await ctx.db.patch(a.id, data)
      return a.id
    }
    return await ctx.db.insert("locations", data)
  },
})

// ---------------- Access requests (people who signed up themselves) ----------------
export const listRequests = query({
  args: {},
  handler: async (ctx) => {
    await requirePerm(ctx, "team.manage")
    return (await ctx.db.query("accessRequests").collect()).filter((r) => r.status === "waiting").sort((a, b) => b.at - a.at)
  },
})

export const approveRequest = mutation({
  args: { id: v.id("accessRequests"), name: v.string(), roleId: v.id("roles"), phone: v.optional(v.string()) },
  handler: async (ctx, a) => {
    await requirePerm(ctx, "team.manage")
    const req = await ctx.db.get(a.id)
    if (!req) throw new ConvexError("Request not found")
    if (!a.name.trim()) throw new ConvexError("Write their name")
    const existing = await ctx.db.query("staff").withIndex("by_email", (q) => q.eq("email", req.email)).unique()
    if (existing) await ctx.db.patch(existing._id, { userId: req.userId, roleId: a.roleId, active: true, name: a.name.trim() })
    else await ctx.db.insert("staff", { email: req.email, name: a.name.trim(), phone: a.phone, roleId: a.roleId, userId: req.userId, active: true, createdAt: Date.now() })
    await ctx.db.delete(a.id)
  },
})

export const rejectRequest = mutation({
  args: { id: v.id("accessRequests") },
  handler: async (ctx, { id }) => {
    await requirePerm(ctx, "team.manage")
    await ctx.db.patch(id, { status: "rejected" })
  },
})

/** Per-person switches: start from the role, then turn single permissions on or off for this person. */
export const setStaffPerms = mutation({
  args: { id: v.id("staff"), extraPerms: v.array(v.string()), deniedPerms: v.array(v.string()) },
  handler: async (ctx, a) => {
    const me = await requirePerm(ctx, "team.manage")
    const s = await ctx.db.get(a.id)
    if (!s) throw new ConvexError("Team member not found")
    const role = await ctx.db.get(s.roleId)
    if (role?.permissions.includes("*")) throw new ConvexError("Super Admin always has every permission")
    if (a.id === me.staff._id && a.deniedPerms.includes("team.manage")) throw new ConvexError("You can't remove your own team access")
    const known = new Set([...PERMISSIONS.map((p) => p.key), ...ALL_MOVE_KEYS])
    await ctx.db.patch(a.id, {
      extraPerms: a.extraPerms.filter((p) => known.has(p)),
      deniedPerms: a.deniedPerms.filter((p) => known.has(p)),
    })
  },
})

// ---------------- Reset login (forgotten password) ----------------
/** Removes the email+password login for this email (any capitalisation) and signs them out everywhere.
 *  Their team record, role and history stay. They then choose "First time? Create password" with the same email. */
async function resetLogin(ctx: MutationCtx, email: string) {
  const target = email.trim().toLowerCase()
  const accounts = (await ctx.db.query("authAccounts").collect()).filter((a) => a.provider === "password" && a.providerAccountId.toLowerCase() === target)
  for (const acc of accounts) {
    for (const sess of await ctx.db.query("authSessions").withIndex("userId", (q) => q.eq("userId", acc.userId)).collect()) {
      for (const rt of await ctx.db.query("authRefreshTokens").withIndex("sessionId", (q) => q.eq("sessionId", sess._id)).collect()) await ctx.db.delete(rt._id)
      await ctx.db.delete(sess._id)
    }
    for (const code of (await ctx.db.query("authVerificationCodes").collect()).filter((c) => c.accountId === acc._id)) await ctx.db.delete(code._id)
    await ctx.db.delete(acc._id)
  }
  // unlink the staff record so the new login gets linked to it by email
  const staff = (await ctx.db.query("staff").collect()).find((s) => s.email.toLowerCase() === target)
  if (staff) await ctx.db.patch(staff._id, { userId: undefined, email: target })
  return { removed: accounts.length, staff: staff?.name ?? null }
}

export const resetLoginByEmail = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => resetLogin(ctx, email),
})

export const resetStaffLogin = mutation({
  args: { id: v.id("staff") },
  handler: async (ctx, { id }) => {
    const me = await requirePerm(ctx, "team.manage")
    if (id === me.staff._id) throw new ConvexError("You can't reset your own login here")
    const s = await ctx.db.get(id)
    if (!s) throw new ConvexError("Team member not found")
    return await resetLogin(ctx, s.email)
  },
})

/** Approves one person (by email) as Super Admin — used once for the owner, at his request. */
export const approveOwnerByEmail = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const target = email.trim().toLowerCase()
    const admin = (await ctx.db.query("roles").collect()).find((r) => r.permissions.includes("*"))
    if (!admin) throw new ConvexError("No Super Admin role found")
    const req = (await ctx.db.query("accessRequests").collect()).find((r) => r.email.toLowerCase() === target)
    const user = (await ctx.db.query("users").collect()).find((u) => (u.email ?? "").toLowerCase() === target)
    const userId = req?.userId ?? user?._id
    const existing = (await ctx.db.query("staff").collect()).find((x) => x.email.toLowerCase() === target)
    if (existing) await ctx.db.patch(existing._id, { userId: userId ?? existing.userId, roleId: admin._id, active: true })
    else await ctx.db.insert("staff", { email: target, name: req?.name || "Mosharaf", roleId: admin._id, userId, active: true, createdAt: Date.now() })
    if (req) await ctx.db.delete(req._id)
    return { approved: target, linked: !!userId }
  },
})

/** One-time: the two exchange warehouses (never sent to Pathao). */
export const addExchangeWarehouses = internalMutation({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("locations").collect()
    const out: string[] = []
    for (const name of ["Blackbole CTG Exchange", "Blackbole Exchange Dhaka"]) {
      const old = all.find((l) => l.name.toLowerCase() === name.toLowerCase())
      if (old) { await ctx.db.patch(old._id, { noCourier: true, isDefault: false, pathaoStoreId: undefined, active: true }); out.push(`${name} updated`) }
      else { await ctx.db.insert("locations", { name, active: true, isDefault: false, noCourier: true }); out.push(`${name} added`) }
    }
    return out
  },
})
