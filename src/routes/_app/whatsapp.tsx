import { useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery } from "convex/react"
import { Check, MessageCircle, SkipForward } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { Guard } from "@/components/app-shell"
import { Loading, PageHeader } from "@/components/bits"
import { Button } from "@/components/ui/button"
import { dateTime, errMsg } from "@/lib/format"
import { cn } from "@/lib/utils"

export const Route = createFileRoute("/_app/whatsapp")({
  component: () => (
    <Guard perm="orders.view">
      <WhatsAppQueue />
    </Guard>
  ),
})

function WhatsAppQueue() {
  const [tab, setTab] = useState<"waiting" | "sent">("waiting")
  const stats = useQuery(api.waQueue.stats)

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <PageHeader
        title="WhatsApp Queue"
        sub="AI drafts the message — you tap to open WhatsApp with it already typed in, and press send yourself. Nothing is ever sent automatically, so your regular WhatsApp number stays completely safe."
      />
      <div className="flex gap-2 text-sm">
        <button type="button" onClick={() => setTab("waiting")}
          className={cn("rounded-lg border px-3 py-2", tab === "waiting" ? "border-foreground bg-card font-semibold" : "bg-card text-muted-foreground")}>
          <span className="font-semibold">{stats?.pendingTotal ?? "…"}</span> waiting
        </button>
        <button type="button" onClick={() => setTab("sent")}
          className={cn("rounded-lg border px-3 py-2", tab === "sent" ? "border-foreground bg-card font-semibold" : "bg-card text-muted-foreground")}>
          <span className="font-semibold">{stats?.sentTotal ?? "…"}</span> sent so far
        </button>
      </div>
      {tab === "waiting" ? <Waiting /> : <Sent />}
    </div>
  )
}

function Waiting() {
  const rows = useQuery(api.waQueue.pending)
  const markSent = useMutation(api.waQueue.markSent)
  const skip = useMutation(api.waQueue.skip)

  // Mobile browsers and in-app webviews silently block or no-op a scripted window.open with width/height "popup"
  // features, so on phones we render a real <a href> instead (below) — a true link tap reliably hands off to the
  // WhatsApp app, where a JS popup was failing silently. Desktop keeps the small, reusable docked window.
  const isMobile = typeof navigator !== "undefined" && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
  const openAndSend = async (id: Id<"waQueue">, link: string) => {
    const win = window.open(link, "blackbole_whatsapp", "width=420,height=680")
    if (!win) {
      toast.error("Couldn't open WhatsApp — your browser may be blocking pop-ups. Tap the message text to copy it, then open WhatsApp yourself.")
      return
    }
    try {
      await markSent({ id })
    } catch (e) {
      toast.error(errMsg(e))
    }
  }

  if (!rows) return <Loading />
  if (rows.length === 0) {
    return (
      <div className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">
        Nothing queued right now. New win-back candidates get added here automatically, hourly.
      </div>
    )
  }
  return (
    <div className="space-y-3">
      {rows.map((r) => (
        <div key={r._id} className="rounded-xl border bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <span className="font-semibold">{r.name}</span>
              <span className="ml-2 text-xs text-muted-foreground">{r.phone} · queued {dateTime(r.createdAt)}</span>
            </div>
          </div>
          <p className="mt-2 rounded-lg bg-muted/60 px-3 py-2 text-sm">{r.text}</p>
          <div className="mt-3 flex gap-2">
            {isMobile ? (
              // Real link tap, not a scripted window.open — this is what reliably hands off to the WhatsApp app on
              // phones (deep-link/universal-link handling); a JS popup is what was silently failing before.
              <Button size="sm" className="gap-1.5" asChild>
                <a href={r.link} target="_blank" rel="noopener noreferrer" onClick={() => void markSent({ id: r._id }).catch((e) => toast.error(errMsg(e)))}>
                  <MessageCircle className="size-4" /> Open WhatsApp &amp; send
                </a>
              </Button>
            ) : (
              <Button size="sm" className="gap-1.5" onClick={() => void openAndSend(r._id, r.link)}>
                <MessageCircle className="size-4" /> Open WhatsApp &amp; send
              </Button>
            )}
            <Button size="sm" variant="ghost" className="gap-1.5 text-muted-foreground" onClick={() => void skip({ id: r._id }).catch((e) => toast.error(errMsg(e)))}>
              <SkipForward className="size-4" /> Skip
            </Button>
          </div>
        </div>
      ))}
    </div>
  )
}

function Sent() {
  const rows = useQuery(api.waQueue.sent)
  if (!rows) return <Loading />
  if (rows.length === 0) {
    return <div className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">Nothing sent yet.</div>
  }
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div key={r._id} className="flex items-start gap-3 rounded-xl border bg-card p-3.5">
          <Check className="mt-0.5 size-4 shrink-0 text-tone-green" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-semibold">{r.name}</span>
              <span className="text-xs text-muted-foreground">{r.sentAt ? dateTime(r.sentAt) : "—"}{r.sentBy ? ` · by ${r.sentBy}` : ""}</span>
            </div>
            <p className="mt-0.5 truncate text-sm text-muted-foreground">{r.phone} — {r.text}</p>
          </div>
        </div>
      ))}
    </div>
  )
}
