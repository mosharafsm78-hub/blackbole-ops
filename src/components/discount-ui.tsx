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

/** Website section names. Kept so every Website page can say where it is.
 *  On big screens the Website menu now lives in the left sidebar (like Shopify Admin), so this shows nothing there.
 *  On phones the sidebar is hidden behind the menu button, so a small scrollable row of links is shown instead. */
export type WebsiteTab = "products" | "collections" | "inventory" | "discounts" | "subscribers" | "pages" | "blog" | "navigation" | "themes" | "files" | "settings"
const MOBILE_TABS: { k: WebsiteTab; label: string; to: string; search?: Record<string, string> }[] = [
  { k: "products", label: "Products", to: "/website", search: { tab: "products", view: "live" } },
  { k: "collections", label: "Collections", to: "/website-collections" },
  { k: "inventory", label: "Inventory", to: "/website-inventory" },
  { k: "discounts", label: "Discounts", to: "/website-discounts" },
  { k: "files", label: "Files", to: "/website-files" },
  { k: "navigation", label: "Menus", to: "/website-navigation" },
  { k: "blog", label: "Blog posts", to: "/website-blog" },
  { k: "pages", label: "Pages", to: "/website-pages" },
  { k: "themes", label: "Themes", to: "/website-themes" },
  { k: "settings", label: "Preferences", to: "/website-settings" },
  { k: "subscribers", label: "Subscribers", to: "/website-subscribers" },
]
export function WebsiteTabs({ active }: { active: WebsiteTab }) {
  return (
    <nav aria-label="Website" className="-mx-4 mb-4 flex gap-1.5 overflow-x-auto px-4 pb-1 lg:hidden">
      {MOBILE_TABS.map((t) => (
        <Link
          key={t.k}
          to={t.to as "/website"}
          search={t.search as never}
          aria-current={active === t.k ? "page" : undefined}
          className={cn(
            "whitespace-nowrap rounded-lg px-2.5 py-1 text-[13px] font-medium transition-colors",
            active === t.k ? "bg-foreground text-background" : "bg-card text-muted-foreground shadow-[0_0_0_1px_rgba(0,0,0,0.08)] hover:text-foreground",
          )}
        >{t.label}</Link>
      ))}
    </nav>
  )
}
