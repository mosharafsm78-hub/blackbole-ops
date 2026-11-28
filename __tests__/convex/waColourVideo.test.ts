import { describe, it, expect } from "vitest"
import { colourOfTitle } from "../../convex/whatsappVerify"

describe("WhatsApp video per colour", () => {
  it("reads the colour from the size title", () => {
    expect(colourOfTitle("Black / 42")).toBe("Black")
    expect(colourOfTitle("White/Black / 40")).toBe("White/Black")
    expect(colourOfTitle("42")).toBeNull()
    expect(colourOfTitle(undefined)).toBeNull()
  })
})
