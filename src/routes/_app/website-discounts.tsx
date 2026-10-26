import { useMemo, useState } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery } from "convex/react"
import { Download, Percent, Plus, ShoppingBag, Tag, Truck, Gift, Zap } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Doc } from "@/convex/_generated/dataModel"
import { WebsiteGuard } from "@/components/app-shell"
import { Loading } from "@/components/bits"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Card, EmptyState, IndexSearch, IndexTable, IndexTabs, PageHeader, useSelection, useSort, type IndexColumn } from "@/components/website-ui"
import { dateTime, errMsg } from "@/lib/format"
import { DiscountStatus, KIND_LABEL, combinationsText, kindOf, summaryLine, WebsiteTabs, type Kind, type Status } from "@/components/discount-ui"

export const Route = createFileRoute("/_app/website-discounts")({
  component: () => <WebsiteGuard><DiscountsPage /></WebsiteGuard>,
})

type Row = Doc<"discounts"> & { status: Status }
type View = "all" | "active" | "scheduled" | "expired" | "inactive"

/** The "Select discount type" choices, same four as Shopify. */
const KIND_CHOICES: { kind: Kind; icon: React.ReactNode; text: string }[] = [
  { kind: "products", icon: <Tag className="size-4" />, text: "Money or percentage off chosen collections or products." },
  { kind: "bxgy", icon: <Gift className="size-4" />, text: "Buy a number of items, get more free or at a lower price." },
  { kind: "order", icon: <ShoppingBag className="size-4" />, text: "Money or percentage off the whole order." },
  { kind: "shipping", icon: <Truck className="size-4" />, text: "No delivery charge on the order." },
]

function KindChooser({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const navigate = useNavigate()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Select discount type</DialogTitle>
          <DialogDescription>You can choose a code or make it automatic on the next screen.</DialogDescription>
        </DialogHeader>
        <div className="-mx-2 divide-y">
          {KIND_CHOICES.map((c) => (
            <button key={c.kind} type="button" onClick={() => { onOpenChange(false); navigate({ to: "/website-discount", search: { id: "", kind: c.kind } }) }}
              className="flex w-full items-start gap-3 rounded-lg px-2 py-3 text-left hover:bg-muted/60">
              <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border bg-muted/50 text-muted-foreground">{c.icon}</span>
              <span className="min-w-0"><span className="block text-sm font-medium">{KIND_LABEL[c.kind]}</span><span className="block text-xs text-muted-foreground">{c.text}</span></span>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function DiscountsPage() {
  const rows = useQuery(api.discounts.list) as Row[] | null | undefined
  const colls = useQuery(api.website.collections)
  const setActive = useMutation(api.discounts.setActive)
  const importCodes = useMutation(api.discounts.importShopifyCodes)
  const navigate = useNavigate()
  const [q, setQ] = useState("")
  const [view, setView] = useState<View>("all")
  const [busy, setBusy] = useState(false)
  const [choose, setChoose] = useState(false)
  const sort = useSort<"title" | "used" | "updated">("updated")
  const collName = useMemo(() => new Map<string, string>((colls?.collections ?? []).map((c: any) => [String(c.handle), String(c.title)] as const)), [colls])
  const nameOf = (r: Row) => (r.method === "automatic" ? r.title ?? "Automatic discount" : r.code)

  const inView = (r: Row, v: View) => v === "all" || (v === "inactive" ? r.status === "off" || r.status === "used_up" : r.status === v)
  const list = useMemo(() => {
    const s = q.trim().toUpperCase()
    const out = (rows ?? []).filter((r) => (!s || r.code.includes(s) || (r.title ?? "").toUpperCase().includes(s)) && inView(r, view))
    const k = sort.dir === "asc" ? 1 : -1
    return out.sort((a, b) => k * (sort.by === "title" ? nameOf(a).localeCompare(nameOf(b)) : sort.by === "used" ? (a.usedCount ?? 0) - (b.usedCount ?? 0) : a.updatedAt - b.updatedAt))
  }, [rows, q, view, sort.by, sort.dir]) // eslint-disable-line react-hooks/exhaustive-deps
  const sel = useSelection(list.map((r) => r._id))

  async function bulk(on: boolean) {
    const picked = list.filter((r) => sel.has(r._id))
    try {
      await Promise.all(picked.map((r) => setActive({ id: r._id, active: on })))
      toast.success(`${picked.length} discount${picked.length === 1 ? "" : "s"} turned ${on ? "on" : "off"}`)
      sel.clear()
    } catch (e) { toast.error(errMsg(e)) }
  }

  const columns: IndexColumn<Row>[] = [
    {
      key: "title", label: "Title", sortable: true, render: (r) => (
        <div className="min-w-0 max-w-[26rem]">
          <div className="flex items-center gap-1.5">
            {r.method === "automatic"
              ? <span className="font-semibold group-hover:underline">{nameOf(r)}</span>
              : <span className="font-mono text-[13px] font-semibold group-hover:underline">{r.code}</span>}
            <span className="md:hidden"><DiscountStatus status={r.status} /></span>
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {summaryLine(r, (h) => (r.scope === "collections" ? collName.get(h) ?? h : h), (h) => (r.buyScope === "collections" ? collName.get(h) ?? h : h))}
            {r.endsAt ? ` · ends ${dateTime(r.endsAt)}` : ""}
          </div>
        </div>
      ),
    },
    { key: "status", label: "Status", hideBelow: "md", render: (r) => <DiscountStatus status={r.status} /> },
    {
      key: "method", label: "Method", hideBelow: "lg", render: (r) => r.method === "automatic"
        ? <span className="inline-flex items-center gap-1"><Zap className="size-3.5 text-muted-foreground" />Automatic</span>
        : <span>Code</span>,
    },
    { key: "type", label: "Type", hideBelow: "lg", render: (r) => <span className="whitespace-nowrap">{KIND_LABEL[kindOf(r)]}</span> },
    { key: "combines", label: "Combinations", hideBelow: "lg", render: (r) => combinationsText(r.combines) || <span className="text-muted-foreground">Can't combine</span> },
    { key: "used", label: "Used", sortable: true, align: "right", render: (r) => <>{r.usedCount ?? 0}{r.usageLimit ? <span className="text-muted-foreground"> / {r.usageLimit}</span> : ""}</> },
    {
      key: "on", label: "On", align: "right", render: (r) => (
        <span onClick={(e) => e.stopPropagation()}>
          <Switch checked={r.active} aria-label={`Turn ${nameOf(r)} on or off`} onCheckedChange={async (on) => {
            try { await setActive({ id: r._id, active: on }); toast.success(on ? `${nameOf(r)} is on` : `${nameOf(r)} is off`) } catch (e) { toast.error(errMsg(e)) }
          }} />
        </span>
      ),
    },
  ]

  const count = (v: View) => (rows ?? []).filter((r) => inView(r, v)).length
  return (
    <div className="mx-auto max-w-6xl">
      <WebsiteTabs active="discounts" />
      <PageHeader
        title="Discounts"
        subtitle="Codes shoppers type at checkout and automatic discounts. Changes reach the website within a minute."
        primary={<Button size="sm" onClick={() => setChoose(true)}><Plus className="size-4" /> Create discount</Button>}
      />

      {rows === undefined ? <Loading /> : rows === null ? null : rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Percent />}
            title="Manage discounts and promotions"
            text="Add discount codes and automatic discounts that apply at checkout, or bring in the 14 codes that worked on Shopify."
            secondary={<Button size="sm" variant="outline" disabled={busy} onClick={async () => {
              setBusy(true)
              try { const n = await importCodes({}); toast.success(`${n} Shopify codes added`) } catch (e) { toast.error(errMsg(e)) } finally { setBusy(false) }
            }}><Download className="size-4" /> Bring in Shopify codes</Button>}
            primary={<Button size="sm" onClick={() => setChoose(true)}><Plus className="size-4" /> Create discount</Button>}
          />
        </Card>
      ) : (
        <Card flush>
          <IndexTabs<View>
            value={view} onChange={setView}
            tabs={[
              { id: "all", label: "All" }, { id: "active", label: "Active", count: count("active") }, { id: "scheduled", label: "Scheduled", count: count("scheduled") },
              { id: "expired", label: "Expired", count: count("expired") }, { id: "inactive", label: "Off" },
            ]}
          />
          <IndexSearch value={q} onChange={setQ} placeholder="Search by code or title" />
          <IndexTable
            rows={list} rowId={(r) => r._id} columns={columns} sel={sel}
            sort={{ by: sort.by, dir: sort.dir }} onSort={(k) => sort.toggle(k as "title" | "used")}
            onRowClick={(r) => navigate({ to: "/website-discount", search: { id: r._id } })}
            bulk={<>
              <Button size="sm" variant="outline" onClick={() => bulk(true)}>Turn on</Button>
              <Button size="sm" variant="outline" onClick={() => bulk(false)}>Turn off</Button>
            </>}
            total={list.length}
            empty={<p className="px-6 py-12 text-center text-sm text-muted-foreground">No discounts match.</p>}
          />
        </Card>
      )}
      <KindChooser open={choose} onOpenChange={setChoose} />
    </div>
  )
}
