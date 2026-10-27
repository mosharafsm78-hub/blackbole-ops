import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery } from "convex/react"
import { MessageCircle, SkipForward } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { Guard } from "@/components/app-shell"
import { Loading, PageHeader } from "@/components/bits"
import { Button } from "@/components/ui/button"
import { dateTime, errMsg } from "@/lib/format"

export const Route = createFileRoute("/_app/whatsapp")({
  component: () => (
    <Guard perm="orders.view">
      <WhatsAppQueue />
    </Guard>
  ),
})

function WhatsAppQueue() {
  const rows = useQuery(api.waQueue.pending)
  const stats = useQuery(api.waQueue.stats)
  const markSent = useMutation(api.waQueue.markSent)
  const skip = useMutation(api.waQueue.skip)

  const openAndSend = async (id: Id<"waQueue">, link: string) => {
    window.open(link, "_blank", "noopener,noreferrer")
    try {
      await markSent({ id })
    } catch (e) {
      toast.error(errMsg(e))
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <PageHeader
        title="WhatsApp Queue"
        sub="AI drafts the message — you tap to open WhatsApp with it already typed in, and press send yourself. Nothing is ever sent automatically, so your regular WhatsApp number stays completely safe."
      />
      {stats && (
        <div className="flex gap-3 text-sm">
          <div className="rounded-lg border bg-card px-3 py-2"><span className="font-semibold">{stats.pendingTotal}</span> waiting</div>
          <div className="rounded-lg border bg-card px-3 py-2"><span className="font-semibold">{stats.sentTotal}</span> sent so far</div>
        </div>
      )}
      {!rows ? (
        <Loading />
      ) : rows.length === 0 ? (
        <div className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">
          Nothing queued right now. New win-back candidates get added here automatically, hourly.
        </div>
      ) : (
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
                <Button size="sm" className="gap-1.5" onClick={() => void openAndSend(r._id, r.link)}>
                  <MessageCircle className="size-4" /> Open WhatsApp &amp; send
                </Button>
                <Button size="sm" variant="ghost" className="gap-1.5 text-muted-foreground" onClick={() => void skip({ id: r._id }).catch((e) => toast.error(errMsg(e)))}>
                  <SkipForward className="size-4" /> Skip
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
