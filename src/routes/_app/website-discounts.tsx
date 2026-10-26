import { useMemo, useState } from "react"
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery } from "convex/react"
import { Download, Percent, Plus, Search, Tag } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Doc } from "@/convex/_generated/dataModel"
import { WebsiteGuard } from "@/components/app-shell"
import { Loading } from "@/components/bits"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { dateTime, errMsg, taka } from "@/lib/format"
import { cn } from "@/lib/utils"
import { DiscountStatus, summaryLine, WebsiteTabs, type Status } from "@/components/discount-ui"

export const Route = createFileRoute("/_app/website-discounts")({
  component: () => <WebsiteGuard><DiscountsPage /></WebsiteGuard>,
})

type Row = Doc<"discounts"> & { status: Status }

function DiscountsPage() {
  const rows = useQuery(api.discounts.list) as Row[] | null | undefined
  const colls = useQuery(api.website.collections)
  const setActive = useMutation(api.discounts.setActive)
  const importCodes = useMutation(api.discounts.importShopifyCodes)
  const navigate = useNavigate()
  const [q, setQ] = useState("")
  const [show, setShow] = useState<"all" | "active" | "inactive">("all")
  const [busy, setBusy] = useState(false)
  const collName = useMemo(() => new Map<string, string>((colls?.collections ?? []).map((c: any) => [String(c.handle), String(c.title)] as const)), [colls])
  const list = useMemo(() => {
    const s = q.trim().toUpperCase()
    return (rows ?? []).filter((r) =>
      (!s || r.code.includes(s) || (r.title ?? "").toUpperCase().includes(s)) &&
      (show === "all" || (show === "active" ? r.status === "active" || r.status === "scheduled" : r.status !== "active" && r.status !== "scheduled")))
  }, [rows, q, show])

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Website</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">Discount codes shoppers type at checkout. Changes work on the website within a minute.</p>
        </div>
        <Button size="sm" asChild><Link to="/website-discount" search={{ id: "" }}><Plus className="size-4" /> Create discount</Link></Button>
      </div>
      <WebsiteTabs active="discounts" />

      {rows === undefined ? <Loading /> : rows === null ? null : rows.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed bg-card px-6 py-16 text-center">
          <div className="flex size-11 items-center justify-center rounded-full bg-muted"><Percent className="size-5 text-muted-foreground" /></div>
          <div className="font-medium">No discount codes yet</div>
          <p className="max-w-sm text-sm text-muted-foreground">Create a code like EID10 for 10% off, or bring in the 14 codes that work on Shopify today.</p>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={busy} onClick={async () => {
              setBusy(true)
              try { const n = await importCodes({}); toast.success(`${n} Shopify codes added`) } catch (e) { toast.error(errMsg(e)) } finally { setBusy(false) }
            }}><Download className="size-4" /> Bring in Shopify codes</Button>
            <Button size="sm" asChild><Link to="/website-discount" search={{ id: "" }}><Plus className="size-4" /> Create discount</Link></Button>
          </div>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="flex items-center gap-1 overflow-x-auto border-b px-2 py-1.5">
            {([["all", "All"], ["active", "Active"], ["inactive", "Not active"]] as const).map(([k, l]) => (
              <button key={k} type="button" onClick={() => setShow(k)}
                className={cn("whitespace-nowrap rounded-md px-2.5 py-1 text-[13px] font-medium transition-colors", show === k ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground")}>{l}</button>
            ))}
            <div className="relative ml-auto w-56">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search codes" className="h-8 border-0 bg-transparent pl-8 shadow-none focus-visible:ring-0" />
            </div>
          </div>
          {list.length === 0 ? <p className="px-6 py-12 text-center text-sm text-muted-foreground">No codes match.</p> : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr className="border-b"><th className="py-2 pl-4 pr-3 font-medium">Code</th><th className="hidden py-2 pr-3 font-medium md:table-cell">Status</th><th className="py-2 pr-3 text-right font-medium">Used</th><th className="py-2 pr-4 text-right font-medium">On</th></tr>
              </thead>
              <tbody>
                {list.map((r) => (
                  <tr key={r._id} onClick={() => navigate({ to: "/website-discount", search: { id: r._id } })} className="group cursor-pointer border-b last:border-0 hover:bg-muted/40">
                    <td className="py-2.5 pl-4 pr-3">
                      <div className="flex items-center gap-3">
                        <div className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted/50"><Tag className="size-4 text-muted-foreground" /></div>
                        <div className="min-w-0">
                          <div className="font-mono text-[13px] font-semibold group-hover:underline">{r.code}</div>
                          <div className="truncate text-xs text-muted-foreground">{summaryLine(r, (h) => (r.scope === "collections" ? collName.get(h) ?? h : h))}
                            {r.endsAt ? ` · ends ${dateTime(r.endsAt)}` : ""}</div>
                        </div>
                      </div>
                    </td>
                    <td className="hidden py-2.5 pr-3 md:table-cell"><DiscountStatus status={r.status} /></td>
                    <td className="py-2.5 pr-3 text-right tabular-nums">{r.usedCount ?? 0}{r.usageLimit ? <span className="text-muted-foreground"> / {r.usageLimit}</span> : ""}</td>
                    <td className="py-2.5 pr-4 text-right" onClick={(e) => e.stopPropagation()}>
                      <Switch checked={r.active} aria-label={`Turn ${r.code} on or off`} onCheckedChange={async (on) => {
                        try { await setActive({ id: r._id, active: on }); toast.success(on ? `${r.code} is on` : `${r.code} is off`) } catch (e) { toast.error(errMsg(e)) }
                      }} />
                    </td>
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
