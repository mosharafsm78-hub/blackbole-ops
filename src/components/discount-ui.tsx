// Shared bits for the Website → Discounts pages.
import { Link } from "@tanstack/react-router"
import type { Doc } from "@/convex/_generated/dataModel"
import { taka } from "@/lib/format"
import { cn } from "@/lib/utils"

export type Status = "active" | "scheduled" | "expired" | "off" | "used_up"

export const STATUS_LABEL: Record<Status, string> = { active: "Active", scheduled: "Scheduled", expired: "Expired", off: "Off", used_up: "Used up" }
const STATUS_TONE: Record<Status, string> = {
  active: "bg-tone-green-bg text-tone-green", scheduled: "bg-tone-blue-bg text-tone-blue", expired: "bg-tone-gray-bg text-tone-gray",
  off: "bg-tone-gray-bg text-tone-gray", used_up: "bg-tone-amber-bg text-tone-amber",
}
const DOT: Record<Status, string> = { active: "bg-tone-green", scheduled: "bg-tone-blue", expired: "bg-tone-gray", off: "bg-tone-gray", used_up: "bg-tone-amber" }

export function DiscountStatus({ status }: { status: Status }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold", STATUS_TONE[status])}>
      <span className={cn("size-1.5 rounded-full", DOT[status])} />{STATUS_LABEL[status]}
    </span>
  )
}

/** One plain-English line, e.g. "10% off Sandals · min ৳1,500 · online payment only". */
export function summaryLine(d: Pick<Doc<"discounts">, "type" | "value" | "scope" | "items" | "minSubtotal" | "onlineOnly" | "oncePerCustomer" | "usageLimit">, names?: (h: string) => string) {
  const off = d.type === "percent" ? `${d.value}% off` : `${taka(d.value)} off`
  const label = (h: string) => (names ? names(h) : h)
  const what = d.scope === "all" ? "everything"
    : d.items.length === 1 ? label(d.items[0])
    : `${d.items.length} ${d.scope === "collections" ? "collections" : "products"}`
  return [
    `${off} ${what}`,
    d.minSubtotal ? `min ${taka(d.minSubtotal)}` : "",
    d.onlineOnly ? "online payment only" : "",
    d.oncePerCustomer ? "once per customer" : "",
    d.usageLimit ? `${d.usageLimit} uses max` : "",
  ].filter(Boolean).join(" · ")
}

/** Same title + tab row as the Website page, so every Website page feels like one section (like Shopify Admin). */
export type WebsiteTab = "products" | "collections" | "discounts" | "subscribers" | "pages" | "blog" | "navigation" | "settings"
export function WebsiteTabs({ active }: { active: WebsiteTab }) {
  const cls = (k: string) => cn("-mb-px whitespace-nowrap border-b-2 px-0.5 pb-2.5 text-sm font-medium transition-colors", active === k ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")
  return (
    <div className="mb-4 flex gap-6 overflow-x-auto border-b">
      <Link to="/website" search={{ tab: "products", view: "live" }} className={cls("products")}>Products</Link>
      <Link to="/website" search={{ tab: "collections", view: "live" }} className={cls("collections")}>Collections</Link>
      <Link to="/website-discounts" className={cls("discounts")}>Discounts</Link>
      <Link to="/website-pages" className={cls("pages")}>Pages</Link>
      <Link to="/website-blog" className={cls("blog")}>Blog</Link>
      <Link to="/website-navigation" className={cls("navigation")}>Navigation</Link>
      <Link to="/website-settings" className={cls("settings")}>Settings</Link>
      <Link to="/website-subscribers" className={cls("subscribers")}>Subscribers</Link>
    </div>
  )
}

