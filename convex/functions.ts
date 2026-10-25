// All mutations are built from here so every order change also updates the daily scoreboard (convex/stats.ts).
import { mutation as rawMutation, internalMutation as rawInternalMutation } from "./_generated/server"
import type { DataModel } from "./_generated/dataModel"
import { Triggers } from "convex-helpers/server/triggers"
import { customCtx, customMutation } from "convex-helpers/server/customFunctions"
import { orderStatsTrigger } from "./stats"

const triggers = new Triggers<DataModel>()
triggers.register("orders", orderStatsTrigger)

export const mutation = customMutation(rawMutation, customCtx(triggers.wrapDB))
export const internalMutation = customMutation(rawInternalMutation, customCtx(triggers.wrapDB))
