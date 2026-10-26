// All mutations are built from here so every order change also updates the daily scoreboard (convex/stats.ts).
import { mutation as rawMutation, internalMutation as rawInternalMutation } from "./_generated/server"
import type { DataModel } from "./_generated/dataModel"
import { Triggers } from "convex-helpers/server/triggers"
import { customCtx, customMutation } from "convex-helpers/server/customFunctions"
import { orderStatsTrigger } from "./stats"
import { markDirty } from "./shopifyStock"

const triggers = new Triggers<DataModel>()
triggers.register("orders", orderStatsTrigger)
// live stock → Shopify: stock rows changing, or orders entering/leaving Pending / On Hold
triggers.register("stock", async (ctx, ch) => {
  if (ch.oldDoc?.available !== ch.newDoc?.available) await markDirty(ctx, [ch.newDoc?.variantId ?? ch.oldDoc?.variantId])
})
triggers.register("orders", async (ctx, ch) => {
  const held = (o: any) => !!o && !o.deletedAt && (o.status === "pending" || o.status === "on_hold")
  const a = ch.oldDoc, b = ch.newDoc
  if (held(a) === held(b) && (!held(a) || (a!.locationId === b!.locationId && JSON.stringify(a!.items) === JSON.stringify(b!.items)))) return
  await markDirty(ctx, [...(a?.items ?? []), ...(b?.items ?? [])].map((i: any) => i.variantId))
})

export const mutation = customMutation(rawMutation, customCtx(triggers.wrapDB))
export const internalMutation = customMutation(rawInternalMutation, customCtx(triggers.wrapDB))
