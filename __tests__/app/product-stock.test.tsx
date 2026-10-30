import { describe, expect, it } from "vitest"
import { render, screen, within } from "@testing-library/react"
import {
  STOCK_METRICS,
  StockMetricCards,
  WarehouseStockTable,
  sumWarehouses,
  type WarehouseStock,
} from "@/components/product-stock"

const row = (over: Partial<WarehouseStock> = {}): WarehouseStock => ({
  locationId: "loc-1",
  locationName: "Dhaka Main",
  active: true,
  isDefault: true,
  available: 0,
  committed: 0,
  inTransit: 0,
  returning: 0,
  ...over,
})

describe("stock metric cards", () => {
  it("renders exactly the four metrics, in the Director's order", () => {
    render(<StockMetricCards metrics={{ available: 12, committed: 3, inTransit: 2, returning: 1 }} />)
    const labels = STOCK_METRICS.map((m) => m.label)
    expect(labels).toEqual(["Available", "Committed", "In Transit", "Returning"])
    for (const label of labels) expect(screen.getByText(label)).toBeTruthy()
    expect(within(screen.getByTestId("metric-available")).getByText("12")).toBeTruthy()
    expect(within(screen.getByTestId("metric-committed")).getByText("3")).toBeTruthy()
    expect(within(screen.getByTestId("metric-inTransit")).getByText("2")).toBeTruthy()
    expect(within(screen.getByTestId("metric-returning")).getByText("1")).toBeTruthy()
  })

  it("renders all zeros without breaking", () => {
    render(<StockMetricCards metrics={{ available: 0, committed: 0, inTransit: 0, returning: 0 }} />)
    expect(screen.getAllByText("0")).toHaveLength(4)
  })
})

describe("warehouse stock table", () => {
  it("shows the same four columns as the cards", () => {
    render(<WarehouseStockTable rows={[row()]} sizeTitle="41" totals={sumWarehouses([row()])} />)
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent)
    expect(headers).toEqual(["Warehouse", "Available", "Committed", "In Transit", "Returning"])
  })

  it("lists every warehouse with its own four numbers", () => {
    const rows = [
      row({ locationId: "a", locationName: "Dhaka Main", available: 10, committed: 2, inTransit: 1, returning: 3 }),
      row({ locationId: "b", locationName: "BlackBole CTG", isDefault: false, available: 0, committed: 4 }),
    ]
    render(<WarehouseStockTable rows={rows} sizeTitle="41" totals={sumWarehouses(rows)} />)
    const body = screen.getAllByTestId("warehouse-row")
    expect(body).toHaveLength(2)
    expect(within(body[0]!).getByText("Dhaka Main")).toBeTruthy()
    expect(within(body[1]!).getByText("BlackBole CTG")).toBeTruthy()
    // CTG holds nothing but still shows its committed units — the whole point of the table.
    expect(within(body[1]!).getAllByTestId("cell-committed")[0]!.textContent).toBe("4")
  })

  it("totals the rows so the table reconciles with the cards", () => {
    const rows = [
      row({ locationId: "a", available: 10, committed: 2, inTransit: 1, returning: 3 }),
      row({ locationId: "b", locationName: "CTG", isDefault: false, available: 5, committed: 4, inTransit: 0, returning: 1 }),
    ]
    const totals = sumWarehouses(rows)
    expect(totals).toEqual({ available: 15, committed: 6, inTransit: 1, returning: 4 })
    render(<WarehouseStockTable rows={rows} sizeTitle="41" totals={totals} />)
    const foot = screen.getByTestId("warehouse-total")
    expect(within(foot).getByText("15")).toBeTruthy()
    expect(within(foot).getByText("6")).toBeTruthy()
  })

  it("renders a clean empty state when there are no warehouse rows", () => {
    render(<WarehouseStockTable rows={[]} sizeTitle="41" totals={sumWarehouses([])} />)
    expect(screen.getByTestId("warehouse-empty")).toBeTruthy()
    expect(screen.queryByTestId("warehouse-stock")).toBeNull()
  })

  it("flags an inactive warehouse that still holds stock", () => {
    const rows = [row({ locationName: "Old Depot", active: false, available: 7 })]
    render(<WarehouseStockTable rows={rows} sizeTitle="41" totals={sumWarehouses(rows)} />)
    expect(screen.getByText("Inactive")).toBeTruthy()
    const body = screen.getByTestId("warehouse-row")
    const cells = within(body).getAllByTestId("cell-available")
    expect(cells[0]!.textContent).toBe("7")
  })

  it("wraps the table in a horizontal scroller so four columns fit on a phone", () => {
    render(<WarehouseStockTable rows={[row()]} sizeTitle="41" totals={sumWarehouses([row()])} />)
    const wrap = screen.getByTestId("warehouse-stock")
    expect(wrap.className).toContain("overflow-x-auto")
    // The warehouse name stays pinned while the numbers scroll.
    expect(wrap.querySelector("th")!.className).toContain("sticky")
  })
})
