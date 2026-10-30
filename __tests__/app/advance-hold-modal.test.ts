import { describe, expect, it } from "vitest"
import {
  ADVANCE_REASON_AWAITING, ADVANCE_REASON_PROMISED, ADVANCE_REASON_REFUSED, ADVANCE_REASON_FAILED,
  isAdvanceReason, reasonPresets, resolveReasonToggle,
} from "../../convex/rules"

/**
 * The FORM half of the advance-payment feature. The modal renders exactly these functions, so a regression
 * here is a regression an agent sees: a stale ৳5000 sitting in a field under a reason that never asked for money.
 */

describe("modal reason chips", () => {
  it("offers the two Hold advance reasons on a hold, listed first", () => {
    const hold = reasonPresets("on_hold")
    expect(hold.slice(0, 2)).toEqual([ADVANCE_REASON_AWAITING, ADVANCE_REASON_PROMISED])
    expect(hold).toContain("Customer asked to wait")
  })

  it("offers both advance CANCEL chips first on a cancel, since an advance can be refused or just never arrive", () => {
    const cancel = reasonPresets("cancelled")
    // the two chips that actually end an order come first, ahead of the generic catch-alls
    expect(cancel.slice(0, 2)).toEqual([ADVANCE_REASON_REFUSED, ADVANCE_REASON_FAILED])
    // and the two hold-style reasons stay available, since an agent may cancel mid-promise
    expect(cancel).toContain(ADVANCE_REASON_AWAITING)
    expect(cancel).toContain(ADVANCE_REASON_PROMISED)
    expect(cancel).toContain("Customer cancelled")
  })

  it("drops the old vague 'Advance payment pending' chip so there is one clear option", () => {
    expect(reasonPresets("on_hold")).not.toContain("Advance payment pending")
    expect(reasonPresets("cancelled")).not.toContain("Advance payment pending")
  })

  it("leaves return moves on their own vocabulary — no advance chip there", () => {
    const ret = reasonPresets("returned")
    expect(ret).not.toContain(ADVANCE_REASON_AWAITING)
    expect(ret).not.toContain(ADVANCE_REASON_REFUSED)
    expect(ret).toContain("Wrong size sent")
  })

  it("gives an ordinary move no reason chips at all", () => {
    expect(reasonPresets("approved")).toEqual([])
    expect(reasonPresets(undefined)).toEqual([])
  })
})

describe("toggling a reason never leaves stale advance data", () => {
  it("clears the amount and date when switching from an advance reason to an ordinary one", () => {
    const next = resolveReasonToggle({ from: ADVANCE_REASON_AWAITING, to: "Stock not ready", amount: "5000", date: "2026-11-05" })
    expect(next.amount).toBe("")
    expect(next.date).toBe("")
  })

  it("clears both when switching between two advance reasons, so the agent retypes the new promise", () => {
    // a different advance reason is a different customer promise; carrying 5000 across would silently save
    // the previous figure under the new reason
    const next = resolveReasonToggle({ from: ADVANCE_REASON_AWAITING, to: ADVANCE_REASON_PROMISED, amount: "5000", date: "2026-11-05" })
    expect(next.amount).toBe("")
    expect(next.date).toBe("")
  })

  it("clears both when an advance reason is replaced by free-typed text", () => {
    const next = resolveReasonToggle({ from: ADVANCE_REASON_AWAITING, to: "Customer will pay later", amount: "5000", date: "2026-11-05" })
    expect(next.amount).toBe("")
    expect(next.date).toBe("")
  })

  it("keeps what was typed when re-picking the SAME reason", () => {
    const next = resolveReasonToggle({ from: ADVANCE_REASON_AWAITING, to: ADVANCE_REASON_AWAITING, amount: "5000", date: "2026-11-05" })
    expect(next.amount).toBe("5000")
    expect(next.date).toBe("2026-11-05")
  })

  it("shows the inputs only for the three advance reasons", () => {
    expect(isAdvanceReason(ADVANCE_REASON_AWAITING)).toBe(true)
    expect(isAdvanceReason(ADVANCE_REASON_PROMISED)).toBe(true)
    expect(isAdvanceReason(ADVANCE_REASON_REFUSED)).toBe(true)
    expect(isAdvanceReason("Customer asked to wait")).toBe(false)
    expect(isAdvanceReason("Stock not ready")).toBe(false)
  })
})
