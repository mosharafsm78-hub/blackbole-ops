import { useState } from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "convex/react"
import { api } from "@/convex/_generated/api"
import { Guard } from "@/components/app-shell"
import { Empty, Loading, PageHeader } from "@/components/bits"
import { Button } from "@/components/ui/button"
import { dateTime } from "@/lib/format"
import { cn } from "@/lib/utils"

export const Route = createFileRoute("/_app/satisfaction")({
  component: () => (
    <Guard perm="reports.view">
      <Satisfaction />
    </Guard>
  ),
})

const RANGES = [{ d: 7, l: "7 days" }, { d: 30, l: "30 days" }, { d: 90, l: "90 days" }, { d: 365, l: "1 year" }]

function Satisfaction() {
  const [days, setDays] = useState(30)
  const s = useQuery(api.survey.summary, { days })
  const max = s ? Math.max(1, ...s.dist) : 1
  return (
    <div>
      <PageHeader title="Customer satisfaction" sub="What customers rate us on WhatsApp after delivery (1 = very bad, 10 = excellent).">
        {RANGES.map((r) => <Button key={r.d} size="sm" variant={days === r.d ? "default" : "outline"} onClick={() => setDays(r.d)}>{r.l}</Button>)}
      </PageHeader>
      {!s ? <Loading /> : (
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-4">
            <Stat label="Average rating" value={s.avg == null ? "–" : `${s.avg.toFixed(1)} / 10`} />
            <Stat label="Answered" value={`${s.rated} of ${s.asked}`} sub={s.responseRate == null ? undefined : `${Math.round(s.responseRate * 100)}% answered`} />
            <Stat label="Score (9–10 minus 1–6)" value={s.nps == null ? "–" : String(s.nps)} sub="100 is perfect, below 0 is a problem" />
            <Stat label="Could not be sent" value={String(s.failed)} sub="check Meta if this is high" />
          </div>
          <section className="rounded-lg border bg-card p-5">
            <h3 className="mb-3 font-semibold">How customers rated us</h3>
            {s.rated === 0 ? <Empty title="No ratings yet">Ratings appear here as soon as customers answer.</Empty> : (
              <div className="space-y-1.5">
                {s.dist.map((n, i) => (
                  <div key={i} className="flex items-center gap-2 text-sm">
                    <span className="w-6 text-right tabular-nums">{i + 1}</span>
                    <div className="h-4 flex-1 rounded bg-muted">
                      <div className={cn("h-4 rounded", i + 1 <= 6 ? "bg-red-500" : i + 1 <= 8 ? "bg-amber-500" : "bg-green-600")} style={{ width: `${(n / max) * 100}%` }} />
                    </div>
                    <span className="w-8 tabular-nums text-muted-foreground">{n}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
          <List title="Needs a call (rated 1–6)" rows={s.low} empty="No low ratings. 🎉" />
          <List title="Latest ratings" rows={s.recent} empty="Nothing yet." />
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </div>
  )
}

function List({ title, rows, empty }: { title: string; rows: { id: string; rating: number; name: string; phone: string; invoice: string; orderId: string; at: number; code: string | null }[]; empty: string }) {
  return (
    <section className="rounded-lg border bg-card p-5">
      <h3 className="mb-3 font-semibold">{title}</h3>
      {rows.length === 0 ? <p className="text-sm text-muted-foreground">{empty}</p> : (
        <div className="divide-y">
          {rows.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
              <span className={cn("flex size-8 items-center justify-center rounded-full font-semibold text-white", r.rating <= 6 ? "bg-red-500" : r.rating <= 8 ? "bg-amber-500" : "bg-green-600")}>{r.rating}</span>
              <div className="min-w-0 flex-1">
                <p className="font-medium">{r.name} <span className="font-normal text-muted-foreground">· {r.phone}</span></p>
                <p className="text-xs text-muted-foreground">{r.invoice} · {dateTime(r.at)}{r.code ? ` · code ${r.code}` : ""}</p>
              </div>
              <Link to="/order" search={{ id: r.orderId } as any} className="text-xs text-primary hover:underline">Open order</Link>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
