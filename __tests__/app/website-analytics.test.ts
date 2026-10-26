import { describe, expect, it } from "vitest"
import { bucket, granularities, overlay, pctChange, presetRange, weekStart } from "@/lib/website-analytics"

// 27 Oct 2026, 10:00 in Dhaka
const NOW = Date.parse("2026-10-27T04:00:00Z")

describe("website analytics date ranges", () => {
  it("works out the presets in Bangladesh days", () => {
    expect(presetRange("today", NOW)).toEqual({ fromDay: "2026-10-27", toDay: "2026-10-27" })
    expect(presetRange("yesterday", NOW)).toEqual({ fromDay: "2026-10-26", toDay: "2026-10-26" })
    expect(presetRange("7d", NOW)).toEqual({ fromDay: "2026-10-21", toDay: "2026-10-27" })
    expect(presetRange("30d", NOW).fromDay).toBe("2026-09-28")
    expect(presetRange("90d", NOW).fromDay).toBe("2026-07-30")
    expect(presetRange("month", NOW)).toEqual({ fromDay: "2026-10-01", toDay: "2026-10-27" })
    // 23:30 UTC on the 26th is already the 27th in Dhaka
    expect(presetRange("today", Date.parse("2026-10-26T23:30:00Z")).fromDay).toBe("2026-10-27")
  })

  it("groups days into weeks and months", () => {
    const daily = ["2026-10-25", "2026-10-26", "2026-10-27", "2026-11-01"].map((day, i) => ({ day, sales: 100 * (i + 1), orders: 1 }))
    expect(weekStart("2026-10-27")).toBe("2026-10-26") // Monday
    expect(bucket(daily, "week").map((b) => [b.key, b.sales, b.orders])).toEqual([["2026-10-19", 100, 1], ["2026-10-26", 900, 3]])
    expect(bucket(daily, "month").map((b) => [b.key, b.sales])).toEqual([["2026-10", 600], ["2026-11", 400]])
    expect(bucket(daily, "day")).toHaveLength(4)
    expect(granularities(1)).toEqual(["hour"])
    expect(granularities(30)).toEqual(["day", "week", "month"])
  })

  it("lines up the previous period and works out changes", () => {
    const cur = [{ key: "a", label: "A", sales: 10, orders: 1 }]
    expect(overlay(cur, [{ key: "b", label: "B", sales: 5, orders: 1 }])[0]).toMatchObject({ sales: 10, prevSales: 5, prevLabel: "B" })
    expect(overlay(cur, null)[0].prevSales).toBeNull()
    expect(pctChange(150, 100)).toBe(50)
    expect(pctChange(5, 0)).toBeNull()
    expect(pctChange(0, 0)).toBe(0)
    expect(pctChange(null, 3)).toBeNull()
  })
})
