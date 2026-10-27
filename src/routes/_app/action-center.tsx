import { useMemo, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery } from "convex/react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import { usePolledAction } from "@/lib/use-polled-action"
import { Guard } from "@/components/app-shell"
import { Loading, PageHeader, TeamTag } from "@/components/bits"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { taka, dateTime, errMsg } from "@/lib/format"
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

const LOG_STATUS: Record<string, { label: string; badge: string }> = {
  open: { label: "Open", badge: "bg-tone-amber-bg text-tone-amber" },
  in_progress: { label: "In progress", badge: "bg-tone-blue-bg text-tone-blue" },
  resolved: { label: "Resolved", badge: "bg-tone-green-bg text-tone-green" },
}

function ActionCenter() {
  const data = usePolledAction(api.dashboard.insights, {}, 15 * 60000)
  const findingIds = useMemo(() => (data?.findings ?? []).map((f: any) => f.id), [data])
  const latest = useQuery(api.findingLog.latest, findingIds.length ? { findingIds } : "skip")

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PageHeader title="Action Center" sub="Every problem the data has found over the last 90 days, what AI is doing about it, what still needs you — and a real log of what actually got done." />
      {!data ? <Loading /> : data.findings.length === 0 ? (
        <div className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">
          Nothing flagged right now — once a real pattern shows up (returns, cancellations, repeat customers), it'll appear here.
        </div>
      ) : (
        <div className="space-y-4">
          {data.findings.map((f: any) => {
            const s = STATUS[f.status] ?? STATUS.human
            const ls = latest?.[f.id]
            return (
              <section key={f.id} className={cn("rounded-xl border border-l-4 bg-card p-5", s.border)}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold tracking-wide", s.badge)}>{s.dot} {s.label}</span>
                    {ls && (
                      <span className={cn("inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-bold tracking-wide", LOG_STATUS[ls.status].badge)}>
                        {LOG_STATUS[ls.status].label} by {ls.byName}
                      </span>
                    )}
                    {(f.team as string[] | undefined)?.map((t) => <TeamTag key={t} team={t} />)}
                  </div>
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

                {f.id === "repeat-rate" && <WinbackActivity />}

                <p className="mt-3 text-sm"><span className="font-semibold">{f.status === "automatic" ? "What it does: " : "Do this: "}</span>{f.solution}</p>

                <FindingLog findingId={f.id} />
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** The real, individual automatic actions win-back has taken — not a summary, the actual list: who got
 *  messaged, on which channel, and when. This is "what AI actually did," not a description of what it will do. */
function WinbackActivity() {
  const sms = useQuery(api.winback.activity)
  const wa = useQuery(api.waQueue.activity)
  const merged = useMemo(() => {
    const a = (sms ?? []).map((r) => ({ id: `s-${r._id}`, name: r.name, phone: r.phone, at: r.at, channel: "SMS", ok: r.status === "sent" }))
    const b = (wa ?? []).map((r) => ({ id: `w-${r._id}`, name: r.name, phone: r.phone, at: r.sentAt, channel: "WhatsApp", ok: true }))
    return [...a, ...b].sort((x, y) => y.at - x.at).slice(0, 12)
  }, [sms, wa])

  if (sms === undefined || wa === undefined) return null
  return (
    <div className="mt-3 rounded-lg border px-3.5 py-2.5">
      <div className="text-xs font-bold text-foreground/70">Recent automatic actions — what AI actually did</div>
      {merged.length === 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">Nothing has fired yet — this will fill in as soon as the first message goes out.</p>
      ) : (
        <ul className="mt-1.5 space-y-1 text-xs">
          {merged.map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-2">
              <span>{m.ok ? "✓" : "✗"} {m.channel} to <span className="font-medium">{m.name}</span> <span className="text-muted-foreground">({m.phone})</span></span>
              <span className="shrink-0 text-muted-foreground">{dateTime(m.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** The actual audit trail for a finding: what the team has logged doing about it, oldest first, plus a box to
 *  add the next entry. This is what makes a finding a real, working item instead of a static suggestion. */
function FindingLog({ findingId }: { findingId: string }) {
  const [open, setOpen] = useState(false)
  const entries = useQuery(api.findingLog.list, open ? { findingId } : "skip")
  const log = useMutation(api.findingLog.log)
  const [text, setText] = useState("")
  const [status, setStatus] = useState<"open" | "in_progress" | "resolved">("in_progress")
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    const clean = text.trim()
    if (!clean) return
    setBusy(true)
    try {
      await log({ findingId, text: clean, status })
      setText("")
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-4 border-t pt-3">
      <button type="button" onClick={() => setOpen((v) => !v)} className="text-xs font-semibold text-muted-foreground hover:text-foreground">
        {open ? "Hide" : "Show"} activity log{open && entries ? ` (${entries.length})` : ""}
      </button>
      {open && (
        <div className="mt-2 space-y-3">
          {!entries ? (
            <Loading />
          ) : entries.length === 0 ? (
            <p className="text-xs text-muted-foreground">Nothing logged yet — be the first to say what's being done.</p>
          ) : (
            <ul className="space-y-1.5">
              {entries.map((e) => (
                <li key={e._id} className="rounded-lg bg-muted/50 px-3 py-2 text-xs">
                  <span className={cn("mr-1.5 rounded-full px-1.5 py-0.5 font-bold", LOG_STATUS[e.status].badge)}>{LOG_STATUS[e.status].label}</span>
                  <span className="font-semibold">{e.byName}</span> · {dateTime(e.at)}
                  <p className="mt-0.5 text-foreground">{e.text}</p>
                </li>
              ))}
            </ul>
          )}
          <div className="space-y-2">
            <Textarea value={text} onChange={(ev) => setText(ev.target.value)} placeholder="What did you (or the team) actually do about this?" rows={2} className="text-sm" />
            <div className="flex flex-wrap items-center gap-2">
              {(["open", "in_progress", "resolved"] as const).map((st) => (
                <button key={st} type="button" onClick={() => setStatus(st)}
                  className={cn("rounded-full px-2.5 py-1 text-[11px] font-bold", status === st ? LOG_STATUS[st].badge : "bg-muted text-muted-foreground")}>
                  {LOG_STATUS[st].label}
                </button>
              ))}
              <Button size="sm" disabled={busy || !text.trim()} onClick={() => void submit()} className="ml-auto">Log it</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
