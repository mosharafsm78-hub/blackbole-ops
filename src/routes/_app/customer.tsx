import { useEffect, useState } from "react"
import { Link, createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery } from "convex/react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { CUSTOMER_TAGS } from "@/convex/rules"
import { Guard, useCan } from "@/components/app-shell"
import { ContactButtons, Empty, Loading, Stat, StatusPill, TagPill } from "@/components/bits"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { dateTime, errMsg, invoice, taka } from "@/lib/format"

export const Route = createFileRoute("/_app/customer")({
  validateSearch: (s: Record<string, unknown>) => ({ id: String(s.id ?? "") }),
  component: () => (
    <Guard perm="orders.view">
      <CustomerPage />
    </Guard>
  ),
})

function CustomerPage() {
  const { id } = Route.useSearch()
  const can = useCan()
  const data = useQuery(api.customers.get, id ? { id: id as Id<"customers"> } : "skip")
  const update = useMutation(api.customers.update)
  const [form, setForm] = useState({ name: "", email: "", address: "", tag: "NEW", note: "" })
  useEffect(() => {
    if (data && !data.missing) {
      const c = data.customer
      setForm({ name: c.name, email: c.email ?? "", address: c.address ?? "", tag: c.tag, note: c.note ?? "" })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data && !data.missing ? data.customer._id : null])

  if (!id) return <Empty title="No customer selected" />
  if (data === undefined || data === null) return <Loading />
  if (data.missing) return <Empty title="Customer not found" />
  const c = data.customer
  const rate = c.deliveredCount + c.returnedCount ? Math.round((c.deliveredCount / (c.deliveredCount + c.returnedCount)) * 100) : null

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link to="/customers" className="text-sm text-muted-foreground hover:underline">Customers</Link>
        <span className="text-muted-foreground">/</span>
        <h1 className="text-xl font-semibold">{c.name}</h1>
        <TagPill tag={c.tag} />
        <span className="tabular-nums text-muted-foreground">{c.phone}</span>
        <ContactButtons phone={c.phone} />
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Orders" value={c.orderCount} />
        <Stat label="Delivered" value={c.deliveredCount} />
        <Stat label="Returned" value={c.returnedCount} tone={c.returnedCount ? "red" : undefined} />
        <Stat label="Success rate" value={rate === null ? "—" : `${rate}%`} tone={rate !== null && rate < 70 ? "red" : undefined} />
        <Stat label="Total spent" value={taka(c.totalSpent)} />
      </div>
      <div className="grid gap-4 lg:grid-cols-[1fr_1.6fr]">
        <section className="space-y-3 rounded-lg border bg-card p-4">
          <h2 className="text-sm font-semibold">Details</h2>
          <div className="space-y-1.5"><Label>Name</Label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} disabled={!can("customers.manage")} /></div>
          <div className="space-y-1.5"><Label>Email</Label><Input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} disabled={!can("customers.manage")} /></div>
          <div className="space-y-1.5"><Label>Address</Label><Textarea rows={2} value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} disabled={!can("customers.manage")} /></div>
          <div className="space-y-1.5">
            <Label>Tag</Label>
            <Select value={form.tag} onValueChange={(v) => setForm({ ...form, tag: v })} disabled={!can("customers.manage")}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{CUSTOMER_TAGS.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5"><Label>Internal note</Label><Textarea rows={3} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} disabled={!can("customers.manage")} placeholder="e.g. Prefers evening delivery; returned twice for size" /></div>
          {can("customers.manage") && (
            <Button onClick={async () => {
              try { await update({ id: c._id, name: form.name, email: form.email || undefined, address: form.address || undefined, tag: form.tag, note: form.note || undefined }); toast.success("Customer saved") } catch (e) { toast.error(errMsg(e)) }
            }}>Save</Button>
          )}
          <p className="text-xs text-muted-foreground">Customer since {dateTime(c.createdAt)} · first came from {c.source ?? "—"}</p>
        </section>
        <section className="rounded-lg border bg-card">
          <h2 className="border-b px-4 py-2.5 text-sm font-semibold">Orders</h2>
          <div className="divide-y">
            {data.orders.map((o) => (
              <Link key={o._id} to="/order" search={{ id: o._id }} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm hover:bg-muted/30">
                <span className="w-24 font-medium text-tone-blue">{invoice(o.invoiceNo)}</span>
                <span className="w-36 text-xs text-muted-foreground">{dateTime(o.createdAt)}</span>
                <span className="min-w-0 flex-1 truncate text-xs">{o.items.map((i) => `${i.qty}× ${i.name}${i.attrs ? ` ${i.attrs}` : ""}`).join(", ")}</span>
                <span className="tabular-nums">{taka(o.total)}</span>
                <StatusPill status={o.status} />
              </Link>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}
