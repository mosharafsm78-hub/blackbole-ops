import { act, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// A fake Convex client whose connection we control.
let state = { isWebSocketConnected: false, hasEverConnected: false }
const subs = new Set<(s: typeof state) => void>()
const client = {
  connectionState: () => state,
  subscribeToConnectionState: (cb: (s: typeof state) => void) => { subs.add(cb); return () => { subs.delete(cb) } },
}
vi.mock("convex/react", () => ({ useConvex: () => client })) // the real client is one stable object too
const setConn = (s: Partial<typeof state>) => { state = { ...state, ...s }; subs.forEach((cb) => cb(state)) }

import { ConnectionBanner, SlowHint, page, reloadOnce } from "@/lib/connection-health"

const reload = vi.fn()
beforeEach(() => {
  vi.useFakeTimers()
  sessionStorage.clear()
  reload.mockReset()
  page.reload = reload
  state = { isWebSocketConnected: false, hasEverConnected: false }
})
afterEach(() => vi.useRealTimers())

describe("Ops never loads forever", () => {
  it("reloads at most once a minute, then again later (a phone tab open for days still recovers)", () => {
    expect(reloadOnce()).toBe(true)
    expect(reloadOnce()).toBe(false)
    vi.advanceTimersByTime(61_000)
    expect(reloadOnce()).toBe(true)
    expect(reload).toHaveBeenCalledTimes(2)
  })

  it("a stuck full-screen loader shows Reload, then reloads by itself while there is no connection", () => {
    render(<SlowHint after={8} autoReload />)
    expect(screen.queryByTestId("slow-hint")).toBeNull()
    act(() => { vi.advanceTimersByTime(9_000) })
    expect(screen.getByTestId("slow-hint").textContent).toMatch(/Can't reach the server/)
    act(() => { vi.advanceTimersByTime(6_000) })
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it("no automatic reload when connected, or on in-page loaders", () => {
    setConn({ isWebSocketConnected: true, hasEverConnected: true })
    render(<><SlowHint after={8} autoReload /><SlowHint after={8} /></>)
    act(() => { vi.advanceTimersByTime(30_000) })
    expect(reload).not.toHaveBeenCalled()
  })

  it("shows a reconnecting bar only after the connection has been down for 5 seconds", () => {
    setConn({ isWebSocketConnected: true, hasEverConnected: true })
    render(<ConnectionBanner />)
    act(() => { setConn({ isWebSocketConnected: false }) })
    act(() => { vi.advanceTimersByTime(4_000) })
    expect(screen.queryByTestId("connection-banner")).toBeNull()
    act(() => { vi.advanceTimersByTime(2_000) })
    expect(screen.getByTestId("connection-banner")).toBeTruthy()
    act(() => { setConn({ isWebSocketConnected: true }) })
    expect(screen.queryByTestId("connection-banner")).toBeNull()
  })
})
