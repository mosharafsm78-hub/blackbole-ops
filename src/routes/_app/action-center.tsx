import { createFileRoute } from "@tanstack/react-router"
import { api } from "@/convex/_generated/api"
import { usePolledAction } from "@/lib/use-polled-action"
import { Guard } from "@/components/app-shell"
import { Loading, PageHeader } from "@/components/bits"
import { taka } from "@/lib/format"
import { cn } from "@/lib/utils"

export const Route = createFileRoute("/_app/action-center")({
  component: () => (
    <Guard perm="dashboard.view">
      <ActionCenter />
    </Guard>
  ),
})

const STATUS: Record<string, { label: string; dot: string; badge: string; border: string; box: string }> = {
  automatic: { label: "AUTOMATIC", dot: "●", badge: "bg-tone-green-bg text-tone-green", border: "border-l-tone-green", box: "bg-tone-green-bg/40" },
  human: { label: "NEEDS A HUMAN", dot: "●", badge: "bg-muted text-muted-foreground", border: "border-l-muted-foreground/40", box: "bg-muted/60" },
  setup: { label: "NEEDS SETUP", dot: "●", badge: "bg-tone-amber-bg text-tone-amber", border: "border-l-tone-amber", box: "bg-tone-amber-bg/40" },
}

function ActionCenter() {
  const data = usePolledAction(api.dashboard.insights, {}, 15 * 60000)
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PageHeader title="Action Center" sub="Every problem the data has found over the last 90 days, what AI is doing about it, and what still needs you." />
      {!data ? <Loading /> : data.findings.length === 0 ? (
        <div className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">
          Nothing flagged right now — once a real pattern shows up (returns, cancellations, repeat customers), it'll appear here.
        </div>
      ) : (
        <div className="space-y-4">
          {data.findings.map((f: any) => {
            const s = STATUS[f.status] ?? STATUS.human
            return (
              <section key={f.id} className={cn("rounded-xl border border-l-4 bg-card p-5", s.border)}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold tracking-wide", s.badge)}>{s.dot} {s.label}</span>
                  <span className="text-xs text-muted-foreground">~{taka(f.impact)} impact</span>
                </div>
                <h2 className="mt-3 text-base font-semibold">{f.problem}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{f.finding}</p>

                <div className={cn("mt-3 rounded-lg px-3.5 py-2.5", s.box)}>
                  <div className="text-xs font-bold text-foreground/70">{f.status === "automatic" ? "AI is doing" : "AI found"}</div>
                  <div className="mt-0.5 text-sm">{f.aiDid}</div>
                </div>

                {f.detail?.length > 0 && (
                  <div className="mt-2 rounded-lg border px-3.5 py-2.5">
                    <div className="text-xs font-bold text-foreground/70">Last {f.detail.length} return reason{f.detail.length > 1 ? "s" : ""}</div>
                    <ul className="mt-1 space-y-0.5 text-sm text-muted-foreground">
                      {f.detail.map((r: string, i: number) => <li key={i}>· {r}</li>)}
                    </ul>
                  </div>
                )}

                <p className="mt-3 text-sm"><span className="font-semibold">{f.status === "automatic" ? "What it does: " : "Do this: "}</span>{f.solution}</p>
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}
