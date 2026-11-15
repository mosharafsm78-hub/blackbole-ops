// The target plans, the Marketing OS stock list and the website catalog are kept in the `cache` table for a while
// (rebuilding them reads every product, size and stock row — the biggest database cost). When the team edits
// stock counts or products, these copies are dropped at once so the next view rebuilds them with the change.
// Orders are deliberately NOT a reason: they come in all day, and the plans are fine a few minutes behind them.
import type { GenericMutationCtx } from "convex/server"
import type { DataModel } from "./_generated/dataModel"

const PREFIXES = ["target-data:", "marketing-data:", "feed-stock:", "feed-catalog"]

export async function bustPlanCaches(ctx: Pick<GenericMutationCtx<DataModel>, "db">): Promise<void> {
  for (const p of PREFIXES) {
    const rows = await ctx.db.query("cache").withIndex("by_key", (q) => q.gte("key", p).lt("key", `${p}￿`)).take(50)
    for (const r of rows) await ctx.db.delete(r._id)
  }
}
