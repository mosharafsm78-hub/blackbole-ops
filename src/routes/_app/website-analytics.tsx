// Website → Analytics: Shopify-style reports for the brand's own website, worked out from Ops orders and checkouts.
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { ChartColumn } from "lucide-react"
import { WebsiteGuard } from "@/components/app-shell"
import { Loading } from "@/components/bits"
import { Card, EmptyState, PageHeader } from "@/components/website-ui"
import {
  Channels, CheckoutFunnel, Delta, DiscountCodes, Metric, RangePicker, SalesBreakdown, SalesChart, TopProducts, Updated, useWebsiteOverview, type Overview,
} from "@/components/website-analytics-parts"
import { isRangeKey, type RangeKey } from "@/lib/website-analytics"
import { taka } from "@/lib/format"

export const Route = createFileRoute("/_app/website-analytics")({
  validateSearch: (s: Record<string, unknown>): { range?: RangeKey } => (isRangeKey(s.range) ? { range: s.range } : {}),
  component: () => <WebsiteGuard><AnalyticsPage /></WebsiteGuard>,
})

function AnalyticsPage() {
  const { range = "30d" } = Route.useSearch()
  const navigate = useNavigate({ from: "/website-analytics" })
  const data = useWebsiteOverview(range)
  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="Analytics" subtitle="Sales, products, discount codes and checkouts on the website." />
      <div className="mb-4"><RangePicker value={range} onChange={(k) => navigate({ search: { range: k } })} data={data} /></div>
      {data === undefined ? <Loading /> : data === null ? (
        <Card><EmptyState icon={<ChartColumn />} title="No access" text="Website analytics are for people who manage the website." /></Card>
      ) : <Report data={data} />}
    </div>
  )
}

function Report({ data }: { data: Overview }) {
  const s = data.cur.summary
  const p = data.prev?.summary ?? null
  const spark = (k: "sales" | "orders") => data.cur.daily.map((d) => d[k])
  const prevSpark = (k: "sales" | "orders") => data.prev?.daily.map((d) => d[k]) ?? null
  const one = data.days <= 1
  const hourSpark = (k: "sales" | "orders") => data.cur.hourly.map((h) => h[k])
  const prevHourSpark = (k: "sales" | "orders") => data.prev?.hourly.map((h) => h[k]) ?? null
  const sp = (k: "sales" | "orders") => (one ? hourSpark(k) : spark(k))
  const psp = (k: "sales" | "orders") => (one ? prevHourSpark(k) : prevSpark(k))
  const c = data.checkouts
  const pc = data.prevCheckouts
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label="Total sales" value={taka(s.total)} now={s.total} before={p?.total ?? null} spark={sp("sales")} prevSpark={psp("sales")} hint="Net sales + delivery charges (website orders, not cancelled)" />
        <Metric label="Orders" value={s.orders} now={s.orders} before={p?.orders ?? null} spark={sp("orders")} prevSpark={psp("orders")} />
        <Metric label="Average order value" value={taka(s.aov)} now={s.aov} before={p?.aov ?? null} hint="(Gross sales − discounts) ÷ orders, delivery not included" />
        <Metric label="Returning customer rate" value={s.returningRate == null ? "—" : `${s.returningRate}%`} now={s.returningRate} before={p?.returningRate ?? null}
          hint="Customers in these dates who had ordered before (any channel) or ordered more than once" />
        <Metric label="Abandoned checkouts" value={c.abandoned} now={c.abandoned} before={pc?.abandoned ?? null} invert hint={`${taka(c.abandonedValue)} left in carts`} />
        <Metric label="Recovered checkouts" value={`${c.recovered} · ${taka(c.recoveredValue)}`} now={c.recoveredValue} before={pc?.recoveredValue ?? null} />
        <Metric label="Checkout conversion" value={c.checkoutConversion == null ? "—" : `${c.checkoutConversion}%`} now={c.checkoutConversion} before={pc?.checkoutConversion ?? null} hint="Checkouts that ended in an order ÷ checkouts started" />
        <Metric label="Units sold" value={s.units} now={s.units} before={p?.units ?? null} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <SalesChart data={data} />
          <SalesChart data={data} metric="orders" title="Orders over time" />
        </div>
        <div className="space-y-4">
          <SalesBreakdown s={s} p={p} />
          <Customers s={s} p={p} />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <TopProducts products={data.products} limit={15} />
        <div className="space-y-4">
          <Channels rows={data.channels} />
          <CheckoutFunnel c={c} p={pc} orders={s.orders} />
        </div>
      </div>

      <DiscountCodes rows={data.discountCodes} orders={s.orders} />
      {data.shopifyCheckouts.started > 0 && (
        <p className="text-xs text-muted-foreground">
          Also in these dates: {data.shopifyCheckouts.started} older Shopify checkouts / draft orders ({data.shopifyCheckouts.abandoned} abandoned, {data.shopifyCheckouts.recovered} recovered), not counted above.
        </p>
      )}
      <Updated at={data.computedAt} />
    </div>
  )
}

function Customers({ s, p }: { s: Overview["cur"]["summary"]; p: Overview["cur"]["summary"] | null }) {
  const first = s.customers - s.returning
  const share = s.customers ? (s.returning / s.customers) * 100 : 0
  return (
    <Card title="Customers">
      <div className="flex items-baseline gap-2"><span className="text-xl font-bold tabular-nums">{s.customers}</span><Delta now={s.customers} before={p?.customers ?? null} /></div>
      <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/10">
        <div className="h-full bg-tone-blue" style={{ width: `${share}%` }} />
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 text-[13px]">
        <div><span className="mr-1.5 inline-block size-2 rounded-full bg-tone-blue" />Returning <span className="font-semibold tabular-nums">{s.returning}</span></div>
        <div><span className="mr-1.5 inline-block size-2 rounded-full bg-black/20 dark:bg-white/25" />First-time <span className="font-semibold tabular-nums">{first}</span></div>
      </div>
    </Card>
  )
}
