import { useEffect, useState } from "react"
import { useAction, useMutation, useQuery } from "convex/react"
import { AlertTriangle, Check, Pencil, Plus, RotateCcw, Trash2, X } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import { GROUP_SHARE, type ProductRow } from "@/convex/targetPlan"
import type { ProductOverride } from "@/convex/targetPlan"
import type { MarketingProgress } from "@/convex/targets"
import { Pill } from "@/components/bits"
import { RestockSuggestions } from "@/components/restock-suggestions"
import {
  dayLabel, Fig, GROUPS, MarketingStrip, Models, Schedule, SellList, monthLabel, sum,
} from "@/components/revenue-target-card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { usePolledAction } from "@/lib/use-polled-action"
import { errMsg, taka } from "@/lib/format"
import { cn } from "@/lib/utils"

/** Marketing's own page: live, refreshes every minute or instantly via the returned refetch. */
export const useMarketingProgress = () => usePolledAction(api.targets.marketingProgress, {}, 60000)

/** The whole Target page, now solely for Marketing: the ৳18,00,000-style gross-sale target — counted from the
 *  moment an order is placed, not approved or delivered — daily pacing toward it, which products (how many pairs
 *  of each) need to sell to reach it against current stock, and the ad budget the target itself needs (worked out
 *  from revenue per taka of ad spend on PLACED orders over the last 30 days — Marketing's own efficiency, not the
 *  Cx page's delivered-revenue one). Deliberately carries none of the Cx/delivery team's other numbers (profit,
 *  break-even, suggested pricing) — those depend on delivery outcomes and will live on a separate Customer Care
 *  page once that's built. */
export function MarketingTargetView({ data, refetch }: { data: MarketingProgress; refetch: () => void }) {
  const p = data.plan
  const t = p.focus
  const beaten = p.remaining === 0
  const onPace = p.pct >= (p.days.length / p.daysInMonth) * 100
  // How much ad spend per day, for the rest of the month, to still deliver the part of the gross target that's
  // missing — neededForRest is that spend for the whole remaining stretch at the last-30-days efficiency, so
  // dividing by daysLeft turns it into a daily figure, the same way perDayFromTomorrow does for revenue.
  const x = data.marketing?.state === "ok" ? data.marketing.plan : null
  const dailyAdBudget = x && x.neededForRest !== null && p.daysLeft > 0 ? Math.ceil(x.neededForRest / p.daysLeft) : null
  return (
    <div className="space-y-4" data-testid="marketing-target-page">
      <p className="text-xs text-muted-foreground">
        {dayLabel(p.start)} → {dayLabel(p.end)} · {p.daysInMonth} days · every order counted the moment it's placed, whatever happens to it after
      </p>
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-xl border bg-card p-4" data-testid="marketing-target-daily">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">{t?.upcoming ? `Daily target — starts ${dayLabel(t.day)}` : `Today's target — ${t ? dayLabel(t.day) : ""}`}</h2>
            {t && !t.upcoming && <Pill tone={t.toGo === 0 ? "green" : "amber"}>{t.toGo === 0 ? "Done for today" : `${taka(t.toGo)} to go`}</Pill>}
          </div>
          <div className="mt-2 text-3xl font-bold tabular-nums">{t ? taka(t.target) : "—"}</div>
          <p className="text-xs text-muted-foreground">
            {t ? (t.upcoming ? "Each day's share of the month." : `${taka(t.delivered)} placed so far today.`) : "The period is over."}
          </p>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Fig label="Each day after today" value={p.perDayFromTomorrow > 0 ? taka(p.perDayFromTomorrow) : "—"} sub={p.perDayFromTomorrow > 0 ? "to still land the month" : beaten ? "nothing more needed" : "no days left"} />
            <Fig label="Days left" value={String(p.daysLeft)} sub="including today" />
            <Fig label="Daily ad budget" value={dailyAdBudget !== null ? taka(dailyAdBudget) : "—"} sub={dailyAdBudget !== null ? "per day, to still reach the target" : "no ad data yet"} />
          </div>
        </section>
        <section className="rounded-xl border border-tone-violet/30 bg-tone-violet-bg/20 p-4" data-testid="marketing-target-monthly">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">Gross sale target — {monthLabel(p.month)}</h2>
            <Pill tone={beaten || onPace ? "green" : "violet"}>{beaten ? "Target reached" : `${p.pct}%`}</Pill>
          </div>
          <div className="mt-2 text-3xl font-bold tabular-nums">{taka(p.target)}</div>
          <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={Math.min(100, p.pct)} aria-valuemin={0} aria-valuemax={100}>
            <div className={cn("h-full rounded-full", beaten || onPace ? "bg-tone-green" : "bg-tone-violet")} style={{ width: `${Math.min(100, p.pct)}%` }} />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <Fig label="Placed so far" value={taka(p.delivered)} sub="every order's full total, once placed" />
            <Fig label="Still needed" value={taka(p.remaining)} sub={p.finished ? "period is over" : `${p.daysLeft} day${p.daysLeft === 1 ? "" : "s"} left`} />
          </div>
        </section>
      </div>

      {data.marketing && <MarketingStrip m={data.marketing} />}
      <RestockSuggestions restock={data.restock} restockDismissedCount={data.restockDismissedCount} refetch={refetch} />
      <SellList products={data.products} day={t ? dayLabel(t.day) : ""} budget={0} />
      <Models products={data.products} />
      <Schedule p={p} />
      <MarketingProductPlan data={data} refetch={refetch} />
    </div>
  )
}

/** Every product's share of the gross target, in pairs, in three groups — same mechanics as the Cx product plan,
 *  minus the suggested-price column (that math is tied to profit/ad-spend, which this page doesn't carry) — plus
 *  Marketing's own manual say over it: add a product that wouldn't otherwise qualify, drop one from the list, or
 *  fix a product's own target instead of the automatic split. */
function MarketingProductPlan({ data, refetch }: { data: MarketingProgress; refetch: () => void }) {
  const rows = data.products
  const overrides = useQuery(api.targets.marketingOverrides, {}) ?? {}
  const [adding, setAdding] = useState(false)
  if (!rows) return null
  const gap = data.productInfo?.gap ?? 0
  const short = data.productInfo?.unitsShort ?? 0
  return (
    <section className="rounded-xl border bg-card p-4" data-testid="marketing-target-products">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Which products — pairs needed to reach the gross target</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">Split by what sold best in the last {data.productInfo?.windowDays} days, capped by stock. Re-planned every week. Edit or remove a product, or add one of your own, any time.</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setAdding((a) => !a)}>
          <Plus className="size-4" />{adding ? "Cancel" : "Add product"}
        </Button>
      </div>
      {adding && <AddProductPanel onDone={() => { setAdding(false); refetch() }} />}
      {rows.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">No orders or stock to base a product plan on yet — add a product above to start one.</p>
      ) : (
        <>
          {gap > 0 && (
            <div className="mt-2 flex items-start gap-2 rounded-lg border border-tone-red/30 bg-tone-red-bg/40 p-2.5 text-xs" data-testid="marketing-stock-gap">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-tone-red" />
              <span><b>Stock can't carry this target.</b> About {taka(gap)} of it has no stock behind it — restock the best sellers or lower the target.</span>
            </div>
          )}
          {gap === 0 && short > 0 && (
            <p className="mt-2 flex items-center gap-1.5 text-xs text-tone-amber"><AlertTriangle className="size-3.5" />{short} pair{short === 1 ? "" : "s"} of the plan are more than current stock — restock soon.</p>
          )}
          <div className="mt-3 space-y-3">
            {GROUPS.map((g) => {
              const list = rows.filter((r) => r.group === g.key)
              if (list.length === 0) return null
              const todayT = list.every((r) => r.todayTarget === null) ? null : sum(list, (r) => r.todayTarget ?? 0)
              const head = (
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <div>
                    <div className="text-sm font-semibold">{g.title} <span className="font-normal text-muted-foreground">· {list.length} · ~{Math.round(GROUP_SHARE[g.key] * 100)}% of the target</span></div>
                    <div className="text-xs text-muted-foreground">{g.note}</div>
                  </div>
                  <div className="text-xs tabular-nums text-muted-foreground">
                    {sum(list, (r) => r.monthUnits)} pairs · {sum(list, (r) => r.sold)} sold{todayT !== null && <> · today <b className="text-foreground">{sum(list, (r) => r.todaySold)}/{todayT}</b></>}
                  </div>
                </div>
              )
              return g.key === "focus" ? (
                <div key={g.key}>{head}<EditableTable rows={list} overrides={overrides} refetch={refetch} /></div>
              ) : (
                <details key={g.key} className="rounded-lg border p-3">
                  <summary className="cursor-pointer select-none list-none">{head}</summary>
                  <EditableTable rows={list} overrides={overrides} refetch={refetch} />
                </details>
              )
            })}
          </div>
        </>
      )}
    </section>
  )
}

/** Search the active catalog and add a product to the plan with its own target — the "add a product" case. Left
 *  blank, the quantity is automatic instead of fixed (useful to force a sold-out or quiet product back in without
 *  pinning an exact number). */
function AddProductPanel({ onDone }: { onDone: () => void }) {
  const search = useAction(api.targets.marketingProductOptions)
  const save = useMutation(api.targets.setMarketingOverride)
  const [loaded, setLoaded] = useState<{ key: string; name: string; stockUnits: number | null; price: number }[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState("")
  const [picked, setPicked] = useState<{ key: string; name: string } | null>(null)
  const [qty, setQty] = useState("")
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    search({}).then((r) => { if (!cancelled) { setLoaded(r); setLoading(false) } }).catch((e) => { if (!cancelled) { toast.error(errMsg(e)); setLoading(false) } })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const matches = (loaded ?? []).filter((o) => o.name.toLowerCase().includes(q.toLowerCase())).slice(0, 8)

  const add = async () => {
    if (!picked) return
    const units = qty.trim() === "" ? undefined : Number(qty)
    if (units !== undefined && (!Number.isFinite(units) || units < 0)) { toast.error("Quantity must be zero or more"); return }
    setBusy(true)
    try {
      await save({ key: picked.key, name: picked.name, included: true, units })
      toast.success(`${picked.name} added to the plan`)
      onDone()
    } catch (e) { toast.error(errMsg(e)) } finally { setBusy(false) }
  }

  return (
    <div className="mt-3 rounded-lg border bg-muted/30 p-3" data-testid="marketing-add-product">
      {!picked ? (
        <>
          <Input autoFocus placeholder="Search products…" value={q} onChange={(e) => setQ(e.target.value)} className="bg-background" />
          <div className="mt-2 max-h-48 space-y-0.5 overflow-y-auto">
            {loading && <p className="px-1 py-1 text-xs text-muted-foreground">Loading…</p>}
            {!loading && q.trim() !== "" && matches.length === 0 && <p className="px-1 py-1 text-xs text-muted-foreground">No matching product.</p>}
            {matches.map((o) => (
              <button
                key={o.key} type="button"
                className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
                onClick={() => setPicked({ key: o.key, name: o.name })}
              >
                <span className="truncate">{o.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{o.stockUnits === null ? "pre-order" : `${o.stockUnits} in stock`}</span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{picked.name}</span>
          <button type="button" className="text-xs text-muted-foreground underline underline-offset-2" onClick={() => setPicked(null)}>change</button>
          <Input
            type="number" min={0} placeholder="Auto" value={qty} onChange={(e) => setQty(e.target.value)}
            className="w-28 bg-background text-right tabular-nums" disabled={busy} aria-label="Target pairs for this product"
          />
          <span className="text-xs text-muted-foreground">pairs this month (blank = let it auto-plan)</span>
          <Button size="sm" disabled={busy} onClick={() => void add()}>{busy ? "Adding…" : "Add"}</Button>
        </div>
      )}
    </div>
  )
}

/** The product-plan table with Marketing's own controls: edit a product's target, remove it from the plan, or
 *  reset one back to automatic. Deliberately a separate component from the shared Cx/Marketing `Table` — row
 *  editing is Marketing-only, and keeping it out of the shared one keeps the (not-yet-built) Cx page untouched. */
function EditableTable({ rows, overrides, refetch }: { rows: ProductRow[]; overrides: Record<string, ProductOverride>; refetch: () => void }) {
  const save = useMutation(api.targets.setMarketingOverride)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState("")
  const [busy, setBusy] = useState<string | null>(null)

  const startEdit = (r: ProductRow) => { setEditing(r.key); setDraft(String(r.monthUnits)) }
  const saveEdit = async (r: ProductRow) => {
    const units = Number(draft)
    if (!Number.isFinite(units) || units < 0) { toast.error("Target must be zero or more"); return }
    setBusy(r.key)
    try { await save({ key: r.key, name: r.name, units }); toast.success(`${r.name}'s target set to ${units} pairs`); setEditing(null); refetch() }
    catch (e) { toast.error(errMsg(e)) } finally { setBusy(null) }
  }
  const remove = async (r: ProductRow) => {
    setBusy(r.key)
    try { await save({ key: r.key, name: r.name, excluded: true }); toast.success(`${r.name} removed from the plan`); refetch() }
    catch (e) { toast.error(errMsg(e)) } finally { setBusy(null) }
  }
  const reset = async (r: ProductRow) => {
    setBusy(r.key)
    try { await save({ key: r.key, name: r.name }); toast.success(`${r.name} back to automatic`); refetch() }
    catch (e) { toast.error(errMsg(e)) } finally { setBusy(null) }
  }

  return (
    <div className="mt-2 overflow-x-auto rounded-lg border">
      <table className="w-full min-w-[640px] text-sm">
        <thead className="bg-muted/50 text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-1.5 text-left font-medium">Product</th>
            <th className="px-3 py-1.5 text-right font-medium">Month plan</th>
            <th className="px-3 py-1.5 text-right font-medium">Sold</th>
            <th className="px-3 py-1.5 text-right font-medium">Today</th>
            <th className="px-3 py-1.5 text-right font-medium">Each day after</th>
            <th className="px-3 py-1.5 text-right font-medium">In stock</th>
            <th className="w-20 px-3 py-1.5" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const manual = overrides[r.key]?.units !== undefined
            return (
              <tr key={r.key} className="border-t">
                <td className="px-3 py-1.5">
                  <div className="font-medium">{r.name}{manual && <span className="ml-1.5 rounded bg-tone-violet/15 px-1 py-0.5 text-[10px] font-semibold text-tone-violet">manual</span>}</div>
                  <div className="text-[11px] text-muted-foreground">
                    {r.left === 0 ? "plan done ✓" : `${r.left} to go`}
                    {r.sizes && r.sizes.total >= 3 && <span className={cn("ml-1.5", r.sizes.inStock / r.sizes.total < 0.6 && "font-semibold text-tone-red")}>{r.sizes.inStock}/{r.sizes.total} sizes</span>}
                    {r.overstock && <span className="ml-1.5 font-semibold text-tone-amber">piling up — push in ads</span>}
                    {r.stockShort > 0 && <span className="ml-1.5 font-semibold text-tone-red">short by {r.stockShort}</span>}
                  </div>
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {editing === r.key ? (
                    <div className="flex items-center justify-end gap-1">
                      <Input
                        autoFocus type="number" min={0} value={draft} onChange={(e) => setDraft(e.target.value)}
                        className="h-7 w-20 text-right tabular-nums" disabled={busy === r.key} aria-label={`Target pairs for ${r.name}`}
                      />
                      <button type="button" className="rounded p-1 text-tone-green hover:bg-muted" disabled={busy === r.key} onClick={() => void saveEdit(r)} aria-label="Save"><Check className="size-3.5" /></button>
                      <button type="button" className="rounded p-1 text-muted-foreground hover:bg-muted" disabled={busy === r.key} onClick={() => setEditing(null)} aria-label="Cancel"><X className="size-3.5" /></button>
                    </div>
                  ) : r.monthUnits}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">{r.sold}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {r.todayTarget === null ? "—" : (
                    <span className={cn(r.toGo === 0 && r.todayTarget > 0 && "text-tone-green")}>
                      {r.todaySold}/{r.todayTarget}{r.toGo === 0 && r.todayTarget > 0 ? " ✓" : ""}
                    </span>
                  )}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{r.perDayAfterToday || "—"}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                  {r.stockUnits === null ? "pre-order" : r.stockUnits}{r.coverDays !== null && <span className="block text-[11px]">{r.coverDays}d cover</span>}
                </td>
                <td className="px-3 py-1.5 text-right">
                  {editing !== r.key && (
                    <div className="flex items-center justify-end gap-1">
                      <button type="button" className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" disabled={busy === r.key} onClick={() => startEdit(r)} aria-label={`Edit ${r.name}'s target`}><Pencil className="size-3.5" /></button>
                      {manual && <button type="button" className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" disabled={busy === r.key} onClick={() => void reset(r)} aria-label={`Reset ${r.name} to automatic`}><RotateCcw className="size-3.5" /></button>}
                      <button type="button" className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-tone-red" disabled={busy === r.key} onClick={() => void remove(r)} aria-label={`Remove ${r.name} from the plan`}><Trash2 className="size-3.5" /></button>
                    </div>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
