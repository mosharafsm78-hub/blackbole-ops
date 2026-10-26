// Website → Subscribers: newsletter sign-ups from the website footer ("Join Now"), with CSV download.
import { useMemo, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useQuery } from "convex/react"
import { Download, Mail, Search } from "lucide-react"
import { api } from "@/convex/_generated/api"
import { WebsiteGuard } from "@/components/app-shell"
import { Loading } from "@/components/bits"
import { WebsiteTabs } from "@/components/discount-ui"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { dateTime } from "@/lib/format"

export const Route = createFileRoute("/_app/website-subscribers")({
  component: () => <WebsiteGuard><Subscribers /></WebsiteGuard>,
})

const csvCell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)

function Subscribers() {
  const rows = useQuery(api.subscribers.list)
  const [q, setQ] = useState("")
  const list = useMemo(() => {
    const s = q.trim().toLowerCase()
    return (rows ?? []).filter((r) => !s || r.email.includes(s) || r.name.toLowerCase().includes(s) || r.phone.includes(s))
  }, [rows, q])

  const download = () => {
    const lines = ["email,name,phone,source,signed_up", ...list.map((r) => [r.email, r.name, r.phone, r.source, new Date(r.createdAt).toISOString()].map(csvCell).join(","))]
    const url = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }))
    const a = document.createElement("a")
    a.href = url; a.download = `blackbole-subscribers-${new Date().toISOString().slice(0, 10)}.csv`; a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Website</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">People who joined the newsletter on the website.</p>
        </div>
        <Button size="sm" variant="outline" disabled={!list.length} onClick={download}><Download className="size-4" /> Download CSV</Button>
      </div>
      <WebsiteTabs active="subscribers" />

      {rows === undefined ? <Loading /> : rows === null ? null : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="flex items-center justify-between gap-3 border-b px-3 py-2">
            <div className="relative max-w-sm flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search email, name or phone" className="h-8 border-0 bg-transparent pl-8 shadow-none focus-visible:ring-0" />
            </div>
            <span className="text-xs tabular-nums text-muted-foreground">{rows.length} subscriber{rows.length === 1 ? "" : "s"}</span>
          </div>
          {list.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-6 py-16 text-center">
              <Mail className="size-8 text-muted-foreground/60" />
              <div className="font-medium">{q ? "No one matches" : "No subscribers yet"}</div>
              <p className="max-w-sm text-sm text-muted-foreground">{q ? "Try another search." : "Sign-ups from the website footer appear here."}</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr className="border-b"><th className="py-2 pl-4 pr-3 font-medium">Email</th><th className="py-2 pr-3 font-medium">Name</th><th className="hidden py-2 pr-3 font-medium sm:table-cell">From</th><th className="py-2 pr-4 text-right font-medium">Joined</th></tr>
              </thead>
              <tbody>
                {list.map((r) => (
                  <tr key={r._id} className="border-b last:border-0">
                    <td className="py-2.5 pl-4 pr-3"><a href={`mailto:${r.email}`} className="hover:underline">{r.email}</a>{r.phone && <div className="text-xs text-muted-foreground">{r.phone}</div>}</td>
                    <td className="py-2.5 pr-3">{r.name || <span className="text-muted-foreground">—</span>}</td>
                    <td className="hidden py-2.5 pr-3 capitalize text-muted-foreground sm:table-cell">{r.source}</td>
                    <td className="py-2.5 pr-4 text-right text-muted-foreground">{dateTime(r.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  )
}
