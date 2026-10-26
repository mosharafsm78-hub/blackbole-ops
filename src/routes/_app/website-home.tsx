// Website → Home: the Shopify Home screen for the brand's own website — today's numbers at a glance and what needs doing.
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router"
import { ChevronRight, House, PhoneCall, ShoppingBag, PackageCheck, PauseCircle } from "lucide-react"
import { WebsiteGuard, useMe } from "@/components/app-shell"
import { Loading } from "@/components/bits"
import { Button } from "@/components/ui/button"
import { Card, EmptyState, PageHeader } from "@/components/website-ui"
import { Metric, RangePicker, SalesChart, TopProducts, Updated, useWebsiteOverview, type Overview } from "@/components/website-analytics-parts"
import { isRangeKey, type RangeKey } from "@/lib/website-analytics"
import { taka } from "@/lib/format"

export const Route = createFileRoute("/_app/website-home")({
  validateSearch: (s: Record<string, unknown>): { range?: RangeKey } => (isRangeKey(s.range) ? { range: s.range } : {}),
  component: () => <WebsiteGuard><HomePage /></WebsiteGuard>,
})

function greeting() {
  const h = new Date(Date.now() + 6 * 3600000).getUTCHours()
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening"
}

function HomePage() {
  const { range = "today" } = Route.useSearch()
  const navigate = useNavigate({ from: "/website-home" })
  const me = useMe()
  const name = (me.name ?? "").split(" ")[0]
  const data = useWebsiteOverview(range, { todo: true })
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title={`${greeting()}${name ? `, ${name}` : ""}`}
        subtitle="Here's what's happening on the website."
        secondary={<Button size="sm" variant="outline" asChild><Link to="/website-analytics" search={{ range }}>View analytics</Link></Button>}
      />
      <div className="mb-4"><RangePicker value={range} onChange={(k) => navigate({ search: { range: k } })} data={data} /></div>
      {data === undefined ? <Loading /> : data === null ? (
        <Card><EmptyState icon={<House />} title="No access" text="The website home is for people who manage the website." /></Card>
      ) : <Home data={data} range={range} />}
    </div>
  )
}

function Home({ data, range }: { data: Overview; range: RangeKey }) {
  const s = data.cur.summary
  const p = data.prev?.summary ?? null
  const one = data.days <= 1
  const pts = (k: "sales" | "orders") => (one ? data.cur.hourly.map((h) => h[k]) : data.cur.daily.map((d) => d[k]))
  const prevPts = (k: "sales" | "orders") => (data.prev ? (one ? data.prev.hourly.map((h) => h[k]) : data.prev.daily.map((d) => d[k])) : null)
  const c = data.checkouts
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label="Total sales" value={taka(s.total)} now={s.total} before={p?.total ?? null} spark={pts("sales")} prevSpark={prevPts("sales")} />
        <Metric label="Orders" value={s.orders} now={s.orders} before={p?.orders ?? null} spark={pts("orders")} prevSpark={prevPts("orders")} />
        <Metric label="Average order value" value={taka(s.aov)} now={s.aov} before={p?.aov ?? null} />
        <Metric label="Returning customer rate" value={s.returningRate == null ? "—" : `${s.returningRate}%`} now={s.returningRate} before={p?.returningRate ?? null} />
      </div>

      {data.todo && <ToDo todo={data.todo} />}

      <SalesChart data={data} />

      <div className="grid gap-4 lg:grid-cols-2">
        <TopProducts products={data.products} limit={5} />
        <Card title="Checkouts">
          <dl className="grid grid-cols-2 gap-4 text-[13px]">
            <Stat label="Started" value={c.started} />
            <Stat label="Abandoned" value={c.abandoned} sub={taka(c.abandonedValue)} />
            <Stat label="Recovered" value={c.recovered} sub={taka(c.recoveredValue)} />
            <Stat label="Recovery rate" value={c.recoveryRate == null ? "—" : `${c.recoveryRate}%`} />
          </dl>
          <Link to="/website-analytics" search={{ range }} className="mt-4 inline-flex items-center gap-1 text-[13px] font-medium text-tone-blue hover:underline">Full report<ChevronRight className="size-3.5" /></Link>
        </Card>
      </div>
      <Updated at={data.computedAt} />
    </div>
  )
}

function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-lg font-bold tabular-nums">{value}</dd>
      {sub && <dd className="text-xs text-muted-foreground">{sub}</dd>}
    </div>
  )
}

function ToDo({ todo }: { todo: NonNullable<Overview["todo"]> }) {
  const items = [
    { n: todo.pending.n, v: todo.pending.v, text: "website orders to confirm", icon: ShoppingBag, to: "/orders" as const, search: { tab: "pending", source: "Website" } },
    { n: todo.onHold.n, v: todo.onHold.v, text: "website orders on hold", icon: PauseCircle, to: "/orders" as const, search: { tab: "on_hold", source: "Website" } },
    { n: todo.approved.n, v: todo.approved.v, text: "website orders to pack", icon: PackageCheck, to: "/orders" as const, search: { tab: "approved", source: "Website" } },
    { n: todo.checkoutsToCall.n, v: todo.checkoutsToCall.v, text: "abandoned checkouts to call (last 7 days)", icon: PhoneCall, to: "/abandoned" as const, search: { tab: "new" } },
  ].filter((i) => i.n > 0)
  if (!items.length) return <Card><p className="text-[13px] text-muted-foreground">All caught up: no website orders waiting and no abandoned checkouts to call.</p></Card>
  return (
    <Card flush>
      <ul className="divide-y divide-black/[0.06] dark:divide-white/[0.06]">
        {items.map((i) => (
          <li key={i.text}>
            <Link to={i.to} search={i.search as never} className="flex items-center gap-3 px-4 py-3 text-[13px] hover:bg-black/[0.03] dark:hover:bg-white/[0.03]">
              <i.icon className="size-4 shrink-0 text-muted-foreground" />
              <span className="flex-1"><span className="font-semibold tabular-nums">{i.n}</span> {i.text}<span className="ml-1.5 text-xs text-muted-foreground">{taka(i.v)}</span></span>
              <ChevronRight className="size-4 text-muted-foreground" />
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  )
}
