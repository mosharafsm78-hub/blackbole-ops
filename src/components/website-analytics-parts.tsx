// Pieces shared by Website → Home and Website → Analytics (Shopify-style metric cards, sales chart, tables).
import { useMemo, useState } from "react"
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { ArrowDownRight, ArrowUpRight, CalendarDays, Check, ChevronDown } from "lucide-react"
import { api } from "@/convex/_generated/api"
import { usePolledAction } from "@/lib/use-polled-action"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Badge, Card, INDEX } from "@/components/website-ui"
import { taka } from "@/lib/format"
import { cn } from "@/lib/utils"
import {
  RANGE_PRESETS, bucket, defaultGranularity, fmtRange, granularities, hourBuckets, overlay, pctChange, presetRange,
  type Granularity, type RangeKey,
} from "@/lib/website-analytics"

// ---------------------------------------------------------------- data
export type Summary = {
  orders: number; gross: number; discounts: number; returns: number; returnedOrders: number; net: number; shipping: number; total: number
  aov: number; units: number; cancelled: number; customers: number; returning: number; returningRate: number | null
}
type Report = { summary: Summary; daily: { day: string; sales: number; orders: number }[]; hourly: { hour: number; sales: number; orders: number }[] }
export type CheckoutStats = {
  started: number; completed: number; abandoned: number; abandonedValue: number; recovered: number; recoveredValue: number; recoveredByTeam: number
  open: number; openValue: number; lost: number; kinds: { webcheckout: number; codform: number; shopify: number }
  recoveryRate: number | null; checkoutConversion: number | null
}
export type Overview = {
  fromDay: string; toDay: string; prevFromDay: string; prevToDay: string; days: number; computedAt: number
  cur: Report; prev: Report | null
  channels: { source: string; orders: number; sales: number }[]
  products: { byUnits: Product[]; bySales: Product[] }
  discountCodes: { code: string; orders: number; sales: number; discount: number }[]
  checkouts: CheckoutStats; prevCheckouts: CheckoutStats | null; shopifyCheckouts: CheckoutStats
  todo: null | { pending: Count; onHold: Count; approved: Count; checkoutsToCall: Count }
}
type Product = { sku: string; name: string; units: number; sales: number }
type Count = { n: number; v: number }

/** Loads the report for a preset; refreshes every 5 minutes while open. undefined = loading, null = no access. */
export function useWebsiteOverview(range: RangeKey, opts: { todo?: boolean } = {}) {
  const { fromDay, toDay } = useMemo(() => presetRange(range), [range])
  return usePolledAction(api.websiteAnalytics.overview, { fromDay, toDay, compare: true, todo: !!opts.todo }, 5 * 60000) as Overview | null | undefined
}

// ---------------------------------------------------------------- range picker
export function RangePicker({ value, onChange, data }: { value: RangeKey; onChange: (k: RangeKey) => void; data?: Overview | null }) {
  const label = RANGE_PRESETS.find((p) => p.key === value)!.label
  return (
    <div className="flex flex-wrap items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline" className="gap-1.5"><CalendarDays className="size-4" />{label}<ChevronDown className="size-3.5 opacity-60" /></Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-44">
          {RANGE_PRESETS.map((p) => (
            <DropdownMenuItem key={p.key} onClick={() => onChange(p.key)}>
              <Check className={cn("size-4", p.key === value ? "opacity-100" : "opacity-0")} />{p.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {data && (
        <span className="text-xs text-muted-foreground">
          {fmtRange(data.fromDay, data.toDay)}
          {data.prev && <> · compared to {fmtRange(data.prevFromDay, data.prevToDay)}</>}
        </span>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- metric card
export function Delta({ now, before, invert, className }: { now: number | null | undefined; before: number | null | undefined; invert?: boolean; className?: string }) {
  const p = pctChange(now, before)
  if (p == null) return <span className={cn("text-xs text-muted-foreground", className)}>—</span>
  if (p === 0) return <span className={cn("text-xs text-muted-foreground", className)}>0%</span>
  const good = invert ? p < 0 : p > 0
  const Icon = p > 0 ? ArrowUpRight : ArrowDownRight
  return (
    <span className={cn("inline-flex items-center gap-0.5 text-xs font-medium tabular-nums", good ? "text-tone-green" : "text-tone-red", className)} title="Change from the previous period">
      <Icon className="size-3.5" />{Math.abs(p)}%
    </span>
  )
}

/** Tiny trend line for a metric card (plain SVG). */
export function Sparkline({ values, prev, className }: { values: number[]; prev?: number[] | null; className?: string }) {
  const all = [...values, ...(prev ?? [])]
  const max = Math.max(1, ...all)
  const path = (vals: number[]) => vals.map((v, i) => `${i ? "L" : "M"}${vals.length > 1 ? (i / (vals.length - 1)) * 100 : 50},${28 - (v / max) * 26}`).join(" ")
  if (values.length < 2) return <div className={cn("h-8", className)} />
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" className={cn("h-8 w-full overflow-visible", className)} aria-hidden>
      {prev && prev.length > 1 && <path d={path(prev)} fill="none" stroke="hsl(var(--tone-blue))" strokeOpacity={0.35} strokeWidth={1.5} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />}
      <path d={path(values)} fill="none" stroke="hsl(var(--tone-blue))" strokeWidth={2} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

export function Metric({ label, value, now, before, invert, spark, prevSpark, hint }: {
  label: string; value: React.ReactNode; now?: number | null; before?: number | null; invert?: boolean; spark?: number[]; prevSpark?: number[] | null; hint?: string
}) {
  return (
    <Card className="min-w-0">
      <div className="text-[13px] font-medium text-muted-foreground" title={hint}>
        <span className={cn(hint && "underline decoration-dotted decoration-muted-foreground/50 underline-offset-4")}>{label}</span>
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="truncate text-xl font-bold tabular-nums">{value}</span>
        {before !== undefined && <Delta now={now} before={before} invert={invert} />}
      </div>
      {spark && <Sparkline values={spark} prev={prevSpark} className="mt-2" />}
    </Card>
  )
}

// ---------------------------------------------------------------- sales over time
export function SalesChart({ data, metric = "sales", title = "Total sales over time" }: { data: Overview; metric?: "sales" | "orders"; title?: string }) {
  const options = granularities(data.days)
  const [pick, setPick] = useState<Granularity | null>(null)
  const by = pick && options.includes(pick) ? pick : defaultGranularity(data.days)
  const rows = useMemo(() => {
    const cur = by === "hour" ? hourBuckets(data.cur.hourly) : bucket(data.cur.daily, by)
    const prev = data.prev ? (by === "hour" ? hourBuckets(data.prev.hourly) : bucket(data.prev.daily, by)) : null
    const rows = overlay(cur, prev)
    // today, hour by hour: like Shopify, the line stops at the current hour instead of dropping to zero for the future
    const dhaka = new Date(Date.now() + 6 * 3600000)
    if (by !== "hour" || data.toDay !== dhaka.toISOString().slice(0, 10)) return rows
    const now = dhaka.getUTCHours()
    return rows.map((r: any, i: number) => (i > now ? { ...r, sales: null, orders: null } : r))
  }, [data, by])
  const key = metric === "sales" ? "sales" : "orders"
  const prevKey = metric === "sales" ? "prevSales" : "prevOrders"
  const fmt = (n: number) => (metric === "sales" ? taka(n) : `${n} order${n === 1 ? "" : "s"}`)
  const total = metric === "sales" ? data.cur.summary.total : data.cur.summary.orders
  const prevTotal = data.prev ? (metric === "sales" ? data.prev.summary.total : data.prev.summary.orders) : null
  return (
    <Card
      title={title}
      action={options.length > 1 && (
        <div className="flex rounded-lg bg-black/[0.05] p-0.5 dark:bg-white/10" role="tablist" aria-label="Group by">
          {options.map((g) => (
            <button key={g} type="button" role="tab" aria-selected={by === g} onClick={() => setPick(g)}
              className={cn("rounded-md px-2 py-0.5 text-xs font-medium capitalize text-muted-foreground", by === g && "bg-card text-foreground shadow-sm")}>{g}</button>
          ))}
        </div>
      )}
    >
      <div className="mb-3 flex items-baseline gap-2">
        <span className="text-2xl font-bold tabular-nums">{metric === "sales" ? taka(total) : total}</span>
        {data.prev && <Delta now={total} before={prevTotal} />}
      </div>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
            <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={11} stroke="hsl(var(--muted-foreground))" interval="preserveStartEnd" minTickGap={28} />
            <YAxis tickLine={false} axisLine={false} fontSize={11} width={metric === "sales" ? 56 : 32} allowDecimals={false} stroke="hsl(var(--muted-foreground))"
              tickFormatter={(n: number) => (metric === "sales" ? (n >= 1000 ? `৳${Math.round(n / 1000)}k` : `৳${n}`) : String(n))} />
            <Tooltip
              contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 10, fontSize: 12 }}
              formatter={(val: any, name: any, item: any) => [fmt(Number(val ?? 0)), name === key ? item?.payload?.label : item?.payload?.prevLabel ?? "Previous period"]}
              labelFormatter={() => ""}
            />
            {data.prev && <Line type="monotone" dataKey={prevKey} stroke="hsl(var(--tone-blue))" strokeOpacity={0.4} strokeWidth={2} strokeDasharray="4 4" dot={false} isAnimationActive={false} />}
            <Line type="monotone" dataKey={key} stroke="hsl(var(--tone-blue))" strokeWidth={2.5} dot={rows.length <= 31 ? { r: 2.5 } : false} activeDot={{ r: 4 }} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      {data.prev && (
        <div className="mt-2 flex flex-wrap gap-4 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5"><span className="h-0.5 w-4 rounded bg-tone-blue" />{fmtRange(data.fromDay, data.toDay)}</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-0 w-4 border-t-2 border-dashed border-tone-blue/50" />{fmtRange(data.prevFromDay, data.prevToDay)}</span>
        </div>
      )}
    </Card>
  )
}

// ---------------------------------------------------------------- breakdown
export function SalesBreakdown({ s, p }: { s: Summary; p?: Summary | null }) {
  const line = (label: string, v: number, pv: number | undefined, opts: { neg?: boolean; bold?: boolean; hint?: string } = {}) => (
    <tr className={INDEX.tr}>
      <td className={cn(INDEX.td, opts.bold && "font-semibold")} title={opts.hint}>{label}</td>
      <td className={cn(INDEX.td, "text-right tabular-nums", opts.bold && "font-semibold")}>{opts.neg && v ? `−${taka(v)}` : taka(v)}</td>
      {p !== undefined && <td className={cn(INDEX.td, "w-20 text-right")}>{p ? <Delta now={v} before={pv} invert={opts.neg} /> : null}</td>}
    </tr>
  )
  return (
    <Card title="Total sales breakdown" flush>
      <table className={INDEX.table}>
        <tbody>
          {line("Gross sales", s.gross, p?.gross, { hint: "Product prices × quantity, before discounts" })}
          {line("Discounts", s.discounts, p?.discounts, { neg: true })}
          {line("Returns", s.returns, p?.returns, { neg: true, hint: "Orders now Returned / Pending return / Damaged" })}
          {line("Net sales", s.net, p?.net, { bold: true })}
          {line("Delivery charges", s.shipping, p?.shipping)}
          {line("Total sales", s.total, p?.total, { bold: true })}
        </tbody>
      </table>
      <p className="px-4 py-3 text-xs text-muted-foreground">Website orders only; cancelled orders are left out{s.cancelled ? ` (${s.cancelled} cancelled)` : ""}.</p>
    </Card>
  )
}

// ---------------------------------------------------------------- channels
export function Channels({ rows }: { rows: Overview["channels"] }) {
  const total = rows.reduce((t, r) => t + r.sales, 0)
  return (
    <Card title="Sales by channel">
      {rows.length === 0 ? <p className="text-sm text-muted-foreground">No orders in these dates.</p> : (
        <ul className="space-y-2.5">
          {rows.map((r) => {
            const share = total ? Math.round((r.sales / total) * 1000) / 10 : 0
            return (
              <li key={r.source}>
                <div className="flex items-baseline justify-between gap-2 text-[13px]">
                  <span className="flex min-w-0 items-center gap-1.5 truncate">{r.source}{r.source === "Website" && <Badge tone="info">This website</Badge>}</span>
                  <span className="shrink-0 tabular-nums">{taka(r.sales)} <span className="text-xs text-muted-foreground">· {r.orders} orders · {share}%</span></span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/10">
                  <div className={cn("h-full rounded-full", r.source === "Website" ? "bg-tone-blue" : "bg-foreground/30")} style={{ width: `${share}%` }} />
                </div>
              </li>
            )
          })}
        </ul>
      )}
      <p className="mt-3 text-xs text-muted-foreground">All Ops orders by source (cancelled left out), so you can see the website next to Facebook, phone and others.</p>
    </Card>
  )
}

// ---------------------------------------------------------------- products
export function TopProducts({ products, limit = 10 }: { products: Overview["products"]; limit?: number }) {
  const [by, setBy] = useState<"units" | "sales">("units")
  const rows = (by === "units" ? products.byUnits : products.bySales).slice(0, limit)
  const max = Math.max(1, ...rows.map((r) => (by === "units" ? r.units : r.sales)))
  return (
    <Card title="Top products" flush action={
      <div className="flex rounded-lg bg-black/[0.05] p-0.5 dark:bg-white/10">
        {(["units", "sales"] as const).map((k) => (
          <button key={k} type="button" onClick={() => setBy(k)} aria-pressed={by === k}
            className={cn("rounded-md px-2 py-0.5 text-xs font-medium text-muted-foreground", by === k && "bg-card text-foreground shadow-sm")}>{k === "units" ? "By units" : "By sales"}</button>
        ))}
      </div>
    }>
      {rows.length === 0 ? <p className="px-4 pb-4 text-sm text-muted-foreground">No products sold on the website in these dates.</p> : (
        <table className={INDEX.table}>
          <thead><tr><th className={INDEX.th}>Product</th><th className={cn(INDEX.th, "text-right")}>Units</th><th className={cn(INDEX.th, "text-right")}>Net sales</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.sku} className={INDEX.tr}>
                <td className={INDEX.td}>
                  <div className="truncate font-medium" title={r.name}>{r.name}</div>
                  <div className="mt-1 flex items-center gap-2">
                    <div className="h-1 flex-1 overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/10"><div className="h-full rounded-full bg-tone-blue" style={{ width: `${((by === "units" ? r.units : r.sales) / max) * 100}%` }} /></div>
                    <span className="font-mono text-[11px] text-muted-foreground">{r.sku}</span>
                  </div>
                </td>
                <td className={cn(INDEX.td, "text-right tabular-nums")}>{r.units}</td>
                <td className={cn(INDEX.td, "text-right tabular-nums")}>{taka(r.sales)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  )
}

// ---------------------------------------------------------------- discount codes
export function DiscountCodes({ rows, orders }: { rows: Overview["discountCodes"]; orders: number }) {
  const used = rows.reduce((t, r) => t + r.orders, 0)
  return (
    <Card title="Discount codes" flush action={orders > 0 && <span className="text-xs text-muted-foreground">{Math.round((used / orders) * 100)}% of website orders used a code</span>}>
      {rows.length === 0 ? <p className="px-4 pb-4 text-sm text-muted-foreground">No discount codes used in these dates.</p> : (
        <table className={INDEX.table}>
          <thead><tr><th className={INDEX.th}>Code</th><th className={cn(INDEX.th, "text-right")}>Orders</th><th className={cn(INDEX.th, "text-right")}>Discount given</th><th className={cn(INDEX.th, "text-right")}>Total sales</th></tr></thead>
          <tbody>
            {rows.slice(0, 15).map((r) => (
              <tr key={r.code} className={INDEX.tr}>
                <td className={cn(INDEX.td, "font-mono text-[13px] font-semibold")}>{r.code}</td>
                <td className={cn(INDEX.td, "text-right tabular-nums")}>{r.orders}</td>
                <td className={cn(INDEX.td, "text-right tabular-nums")}>{taka(r.discount)}</td>
                <td className={cn(INDEX.td, "text-right tabular-nums")}>{taka(r.sales)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="px-4 py-3 text-xs text-muted-foreground">Discount given includes every discount on those orders (automatic ones too).</p>
    </Card>
  )
}

// ---------------------------------------------------------------- checkouts
export function CheckoutFunnel({ c, p, orders }: { c: CheckoutStats; p: CheckoutStats | null; orders: number }) {
  const steps = [
    { label: "Checkouts started", n: c.started, sub: "Phone number typed on the checkout page or Cash-on-delivery form" },
    { label: "Finished without help", n: c.completed, sub: "Ordered within 15 minutes" },
    { label: "Abandoned", n: c.abandoned, sub: `${taka(c.abandonedValue)} in carts` },
    { label: "Recovered", n: c.recovered, sub: `${taka(c.recoveredValue)} · ${c.recoveredByTeam} by the team's calls` },
  ]
  const max = Math.max(1, c.started)
  return (
    <Card title="Checkout funnel">
      {c.started === 0 ? <p className="text-sm text-muted-foreground">No checkouts started on the website in these dates.</p> : (
        <div className="space-y-3">
          {steps.map((s, i) => (
            <div key={s.label}>
              <div className="flex items-baseline justify-between gap-2 text-[13px]">
                <span className="font-medium">{s.label}</span>
                <span className="tabular-nums">{s.n}<span className="ml-1 text-xs text-muted-foreground">{i > 0 ? `${Math.round((s.n / max) * 100)}%` : ""}</span></span>
              </div>
              <div className="mt-1 h-2 overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/10">
                <div className={cn("h-full rounded-full", i === 2 ? "bg-tone-amber" : i === 3 ? "bg-tone-green" : "bg-tone-blue")} style={{ width: `${(s.n / max) * 100}%` }} />
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">{s.sub}</div>
            </div>
          ))}
          <div className="grid grid-cols-2 gap-3 border-t pt-3 text-[13px]">
            <div><div className="text-xs text-muted-foreground">Checkout conversion</div><div className="font-semibold tabular-nums">{c.checkoutConversion ?? "—"}{c.checkoutConversion != null && "%"} {p && <Delta now={c.checkoutConversion} before={p.checkoutConversion} />}</div></div>
            <div><div className="text-xs text-muted-foreground">Recovery rate</div><div className="font-semibold tabular-nums">{c.recoveryRate ?? "—"}{c.recoveryRate != null && "%"} {p && <Delta now={c.recoveryRate} before={p.recoveryRate} />}</div></div>
          </div>
        </div>
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        {orders} website order{orders === 1 ? "" : "s"} in these dates. Visits, product views and add-to-cart are tracked by the Meta pixel, not kept in Ops, so the funnel starts at checkout.
      </p>
    </Card>
  )
}

export function Updated({ at }: { at: number }) {
  return <p className="mt-6 text-center text-xs text-muted-foreground">Numbers refresh every 5 minutes · worked out {new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Dhaka" })}</p>
}
