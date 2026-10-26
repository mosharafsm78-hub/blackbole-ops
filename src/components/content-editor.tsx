// Shared pieces for the Pages and Blog post editors (Website → Content), modelled on Shopify's page/article editors.
import { CalendarClock, X } from "lucide-react"
import { Section } from "@/components/website-ui"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

export const PAGE_TEMPLATES: Record<string, string> = { "": "Default page", contact: "Contact page (with form)", "custom-shoes": "Design your own pair" }

/** Shopify's visibility: Visible, Hidden, or "Visible on <date>" for a date still to come. */
export function visibility(isPublished: boolean, publishedAt: string | null) {
  if (!isPublished) return { tone: "neutral" as const, label: "Hidden" }
  const t = publishedAt ? Date.parse(publishedAt) : NaN
  if (Number.isFinite(t) && t > Date.now()) return { tone: "info" as const, label: `Visible on ${shortDate(t)}` }
  return { tone: "success" as const, label: "Visible" }
}

export const shortDate = (t: number | string) => new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Dhaka" })

// Dates are picked in Bangladesh time (UTC+6, no daylight saving).
const BD = 6 * 3600 * 1000
/** ISO → value for <input type="datetime-local"> in Bangladesh time. */
export function toLocalInput(iso: string | null | undefined) {
  if (!iso) return ""
  const t = Date.parse(iso)
  return Number.isFinite(t) ? new Date(t + BD).toISOString().slice(0, 16) : ""
}
/** <input type="datetime-local"> value (Bangladesh time) → ISO. */
export function fromLocalInput(v: string) {
  return v ? new Date(`${v}:00+06:00`).toISOString() : null
}

/** Visibility card: Visible / Hidden, plus "Set visibility date" to make it appear later by itself. */
export function VisibilityCard({ isPublished, date, onPublished, onDate, dateLabel = "Visibility date", savedDate }: {
  isPublished: boolean; date: string; onPublished: (v: boolean) => void; onDate: (v: string) => void; dateLabel?: string
  /** The publish date saved now (shown as "Visible since …"). */
  savedDate?: string | null
}) {
  const t = date ? Date.parse(`${date}:00+06:00`) : NaN
  const future = Number.isFinite(t) && t > Date.now()
  return (
    <Section title="Visibility">
      <div className="space-y-2">
        {[true, false].map((on) => (
          <label key={String(on)} className="flex cursor-pointer items-start gap-2 text-sm">
            <input type="radio" className="mt-0.5 accent-foreground" checked={isPublished === on} onChange={() => onPublished(on)} />
            <span>
              {on ? (future ? `Visible on ${shortDate(t)}` : "Visible") : "Hidden"}
              {on && isPublished && !future && savedDate && <span className="block text-xs text-muted-foreground">Since {shortDate(savedDate)}</span>}
            </span>
          </label>
        ))}
      </div>
      {isPublished && (date || future ? (
        <div className="mt-3 space-y-1.5">
          <div className="flex items-center justify-between text-[13px] font-medium">{dateLabel}
            <button type="button" onClick={() => onDate("")} className="inline-flex items-center gap-1 text-xs font-normal text-muted-foreground hover:text-foreground"><X className="size-3" /> Clear date</button>
          </div>
          <Input type="datetime-local" value={date} onChange={(e) => onDate(e.target.value)} />
          <p className={cn("text-xs", future ? "text-tone-blue" : "text-muted-foreground")}>
            {future ? "Stays hidden until then, and appears on the website by itself (Bangladesh time)." : "A date in the past just changes the date shown."}
          </p>
        </div>
      ) : (
        <Button size="sm" variant="link" className="mt-1 h-auto px-0 text-tone-blue" onClick={() => onDate(toLocalInput(new Date(Date.now() + 86400000).toISOString()).slice(0, 11) + "10:00")}>
          <CalendarClock className="size-3.5" /> Set visibility date
        </Button>
      ))}
    </Section>
  )
}

/** Shown under the search listing when the web address changed: Shopify's "Create a URL redirect" tick box. */
export function RedirectNotice({ from, to, checked, onChange }: { from: string; to: string; checked: boolean; onChange: (v: boolean) => void }) {
  if (from === to) return null
  return (
    <label className="-mt-2 flex cursor-pointer items-start gap-2 rounded-b-xl border border-t-0 bg-card px-4 py-3 text-[13px]">
      <input type="checkbox" className="mt-0.5 accent-foreground" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>Create a URL redirect for <span className="font-mono text-xs">{from}</span> → <span className="font-mono text-xs">{to}</span>
        <span className="block text-xs text-muted-foreground">So old links and Google results keep working.</span></span>
    </label>
  )
}
