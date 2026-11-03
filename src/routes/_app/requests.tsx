import { useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useQuery } from "convex/react"
import { api } from "@/convex/_generated/api"
import { Guard } from "@/components/app-shell"
import { Empty, Loading, PageHeader } from "@/components/bits"
import { NewRequestDialog, RequestCard } from "@/components/team-requests"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export const Route = createFileRoute("/_app/requests")({
  component: () => (
    <Guard perm="orders.view">
      <RequestsPage />
    </Guard>
  ),
})

const TABS = [
  { k: "toMe", label: "Asked to me" },
  { k: "fromMe", label: "I asked" },
  { k: "open", label: "Everyone's open" },
  { k: "done", label: "Done" },
]

function RequestsPage() {
  const [tab, setTab] = useState("toMe")
  const [open, setOpen] = useState(false)
  const me = useQuery(api.team.me)
  const counts = useQuery(api.teamRequests.myCounts)
  const rows = useQuery(api.teamRequests.list, { scope: tab })
  const meId = me && me.kind === "ok" ? (me.staff._id as string) : null
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader title="Team requests" sub="Ask a colleague for an exchange, a live product picture or an answer. Everything is saved with who asked, who answered and when."><Button onClick={() => setOpen(true)}>New request</Button></PageHeader>
      <div className="flex flex-wrap gap-1.5">
        {TABS.map((t) => {
          const n = t.k === "toMe" ? counts?.toAnswer : t.k === "fromMe" ? counts?.answersIn : 0
          return (
            <button key={t.k} onClick={() => setTab(t.k)} className={cn("rounded-full border px-3 py-1 text-sm font-medium", tab === t.k ? "border-foreground bg-foreground text-background" : "hover:bg-accent")}>
              {t.label}{n ? <span className="ml-1.5 rounded-full bg-tone-red px-1.5 text-[11px] text-white">{n}</span> : null}
            </button>
          )
        })}
      </div>
      {rows === undefined ? <Loading /> : rows.length === 0 ? <Empty title="Nothing here">{tab === "toMe" ? "No one is waiting for your answer." : "No requests in this list."}</Empty> : (
        <div className="space-y-3">{rows.map((r) => <RequestCard key={r._id} r={r} meId={meId} />)}</div>
      )}
      <NewRequestDialog open={open} onOpenChange={setOpen} />
    </div>
  )
}
