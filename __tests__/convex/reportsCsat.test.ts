import { describe, expect, it } from "vitest"
import { build } from "../../convex/reports"
import type { Doc } from "../../convex/_generated/dataModel"

// Feedback/return/recovery call data used to be write-only: captured per order, worth individual KPI points,
// maybe an accountability flag — but nothing ever rolled it up into a trend, a reason breakdown, or a
// per-agent view. These three new report types (csat_trend, return_reasons, csat_by_agent) are what makes that
// data dynamic and business-impactful instead of just sitting on individual order timelines.

function order(fields: Partial<Doc<"orders">> & { source?: string; deletedAt?: number }): Doc<"orders"> {
  return { source: "Website", ...fields } as unknown as Doc<"orders">
}

describe("csat_trend report", () => {
  it("buckets feedback, return and recovery calls by the day the CALL happened, not the order's creation date", () => {
    const orders = [
      order({ csat: { outcome: "Happy — no issues", at: Date.parse("2026-02-01T10:00:00Z"), byName: "Nuha" } }),
      order({ csat: { outcome: "Unhappy — product issue", at: Date.parse("2026-02-01T11:00:00Z"), byName: "Arian" } }),
      order({ csat: { outcome: "Could not reach", at: Date.parse("2026-02-01T12:00:00Z"), byName: "Arian" } }),
      // This order was created long before the window, but its return call happened inside it.
      order({ createdAt: Date.parse("2025-01-01T00:00:00Z"), returnCsat: { outcome: "Wrong size sent", at: Date.parse("2026-02-02T09:00:00Z"), byName: "Nuha" } }),
      order({ returnCsat: { outcome: "Customer changed mind", at: Date.parse("2026-02-02T09:00:00Z"), byName: "Arian" } }),
      order({ recovery: { outcome: "Recovered — placed a new order", at: Date.parse("2026-02-02T10:00:00Z"), byName: "Nuha" } }),
    ]
    const rows = build("csat_trend", orders, 0, Date.now()) as any[]
    const day1 = rows.find((r) => r.Date === "2026-02-01")!
    expect(day1["Feedback calls"]).toBe(3)
    expect(day1["Happy — no issues"]).toBe(1)
    expect(day1["Unhappy — product issue"]).toBe(1)
    expect(day1["Feedback — could not reach"]).toBe(1)
    // 1 real unhappy out of 2 answered calls (the "could not reach" one doesn't count as answered)
    expect(day1["Unhappy %"]).toBe(50)

    const day2 = rows.find((r) => r.Date === "2026-02-02")!
    expect(day2["Return calls"]).toBe(2)
    expect(day2["Return — at fault"]).toBe(1) // "Wrong size sent" is at-fault, "Customer changed mind" isn't
    expect(day2["Recovery calls"]).toBe(1)
    expect(day2.Recovered).toBe(1)
    expect(day2["Win-back %"]).toBe(100)
  })
})

describe("return_reasons report", () => {
  it("breaks down confirmed return-call reasons with at-fault flag and win-back rate", () => {
    const orders = [
      order({ returnCsat: { outcome: "Wrong size sent", at: Date.now(), byName: "Arian" }, recovery: { outcome: "Recovered — placed a new order", at: Date.now(), byName: "Arian" } }),
      order({ returnCsat: { outcome: "Wrong size sent", at: Date.now(), byName: "Nuha" }, recovery: { outcome: "Offered — declined", at: Date.now(), byName: "Nuha" } }),
      order({ returnCsat: { outcome: "Customer changed mind", at: Date.now(), byName: "Arian" } }),
    ]
    const rows = build("return_reasons", orders, 0, Date.now()) as any[]
    const wrongSize = rows.find((r) => r.Reason === "Wrong size sent")!
    expect(wrongSize["At fault"]).toBe("Yes")
    expect(wrongSize.Calls).toBe(2)
    expect(wrongSize["% of return calls"]).toBe(67) // 2 of 3, rounded
    expect(wrongSize["Recovery attempted"]).toBe(2)
    expect(wrongSize.Recovered).toBe(1)
    expect(wrongSize["Win-back %"]).toBe(50)

    const changedMind = rows.find((r) => r.Reason === "Customer changed mind")!
    expect(changedMind["At fault"]).toBe("No")
    expect(changedMind["Win-back %"]).toBe("") // no recovery call made — nothing to divide
  })
})

describe("csat_by_agent report", () => {
  it("rolls up feedback, return and recovery calls per agent so call quality is visible per person", () => {
    const orders = [
      order({ csat: { outcome: "Happy — no issues", at: Date.now(), byName: "Arian" } }),
      order({ csat: { outcome: "Unhappy — delivery issue", at: Date.now(), byName: "Arian" } }),
      order({ csat: { outcome: "Could not reach", at: Date.now(), byName: "Arian" } }),
      order({ returnCsat: { outcome: "Damaged / defective", at: Date.now(), byName: "Arian" } }),
      order({ recovery: { outcome: "Recovered — placed a new order", at: Date.now(), byName: "Arian" } }),
      order({ csat: { outcome: "Happy — minor issue", at: Date.now(), byName: "Nuha" } }),
    ]
    const rows = build("csat_by_agent", orders, 0, Date.now()) as any[]
    const arian = rows.find((r) => r.Agent === "Arian")!
    expect(arian["Feedback calls"]).toBe(3)
    expect(arian.Happy).toBe(1)
    expect(arian.Unhappy).toBe(1)
    expect(arian["Could not reach"]).toBe(1)
    expect(arian["Happy %"]).toBe(50) // 1 happy of 2 answered (3 - 1 could-not-reach)
    expect(arian["Return calls"]).toBe(1)
    expect(arian["Recovery calls"]).toBe(1)
    expect(arian["Win-back %"]).toBe(100)

    const nuha = rows.find((r) => r.Agent === "Nuha")!
    expect(nuha["Feedback calls"]).toBe(1)
    expect(nuha["Happy %"]).toBe(100)
  })
})
