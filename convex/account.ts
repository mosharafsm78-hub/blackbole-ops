import { v, ConvexError } from "convex/values"
import { getAuthUserId, modifyAccountCredentials, retrieveAccount } from "@convex-dev/auth/server"
import { action, internalQuery } from "./_generated/server"
import { internal } from "./_generated/api"

/** The signed-in person's email login (the "password" account). */
export const myLogin = internalQuery({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx)
    if (!userId) return null
    const acc = await ctx.db.query("authAccounts").withIndex("userIdAndProvider", (q) => q.eq("userId", userId).eq("provider", "password")).first()
    return acc ? acc.providerAccountId : null
  },
})

/** Anyone signed in can change their own password (needs the current one). */
export const changePassword = action({
  args: { current: v.string(), next: v.string() },
  handler: async (ctx, { current, next }) => {
    const id: string | null = await ctx.runQuery(internal.account.myLogin, {})
    if (!id) throw new ConvexError("You are not signed in.")
    if (next.length < 8) throw new ConvexError("The new password must be at least 8 characters.")
    if (next === current) throw new ConvexError("The new password is the same as the current one.")
    try {
      await retrieveAccount(ctx, { provider: "password", account: { id, secret: current } })
    } catch {
      throw new ConvexError("Your current password is wrong.")
    }
    await modifyAccountCredentials(ctx, { provider: "password", account: { id, secret: next } })
    return { ok: true }
  },
})
