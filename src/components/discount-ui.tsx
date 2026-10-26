// Shared bits for the Website → Discounts pages.
import { Link } from "@tanstack/react-router"
import type { Doc } from "@/convex/_generated/dataModel"
import { taka } from "@/lib/format"
import { cn } from "@/lib/utils"
import { Badge, type BadgeTone } from "@/components/website-ui"

export type Status = "active" | "scheduled" | "expired" | "off" | "used_up"

export const STATUS_LABEL: Record<Status, string> = { active: "Active", scheduled: "Scheduled", expired: "Expired", off: "Off", used_up: "Used up" }
const STATUS_TONE: Record<Status, string> = {
  active: "bg-tone-green-bg text-tone-green", scheduled: "bg-tone-blue-bg text-tone-blue", expired: "bg-tone-gray-bg text-tone-gray",
  off: "bg-tone-gray-bg text-tone-gray", used_up: "bg-tone-amber-bg text-tone-amber",
}
const DOT: Record<Status, string> = { active: "bg-tone-green", scheduled: "bg-tone-blue", expired: "bg-tone-gray", off: "bg-tone-gray", used_up: "bg-tone-amber" }

const BADGE: Record<Status, BadgeTone> = { active: "success", scheduled: "info", expired: "neutral", off: "neutral", used_up: "attention" }
export function DiscountStatus({ status, plain }: { status: Status; plain?: boolean }) {
  if (!plain) return <Badge tone={BADGE[status]}>{STATUS_LABEL[status]}</Badge>
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold", STATUS_TONE[status])}>
      <span className={cn("size-1.5 rounded-full", DOT[status])} />{STATUS_LABEL[status]}
    </span>
  )
}

export type Kind = "products" | "order" | "bxgy" | "shipping"
export const KIND_LABEL: Record<Kind, string> = { products: "Amount off products", order: "Amount off order", bxgy: "Buy X get Y", shipping: "Free shipping" }
/** Same rule as convex/discounts.ts kindOf: older rows without a kind follow their scope. */
export const kindOf = (d: { kind?: Kind; scope: "all" | "collections" | "products" }): Kind => d.kind ?? (d.scope === "all" ? "order" : "products")
const GROUP_LABEL = { products: "Product", order: "Order", shipping: "Shipping" } as const
/** "Product, shipping" — which other kinds of discount it can be used with. */
export function combinationsText(c?: { products?: boolean; order?: boolean; shipping?: boolean } | null) {
  const on = (["products", "order", "shipping"] as const).filter((k) => c?.[k]).map((k) => GROUP_LABEL[k])
  return on.length ? on.map((x, i) => (i ? x.toLowerCase() : x)).join(", ") : ""
}

type SummaryInput = Pick<Doc<"discounts">, "type" | "value" | "scope" | "items" | "minSubtotal" | "onlineOnly" | "oncePerCustomer" | "usageLimit">
  & Partial<Pick<Doc<"discounts">, "kind" | "minQty" | "buyQty" | "buyScope" | "buyItems" | "getQty" | "maxUses">>

/** One plain-English line, e.g. "10% off Sandals · min ৳1,500 · online payment only". */
export function summaryLine(d: SummaryInput, names?: (h: string) => string, buyNames?: (h: string) => string) {
  const kind = kindOf(d)
  const label = (h: string) => (names ? names(h) : h)
  const list = (scope: string, items: string[], nm: (h: string) => string) => scope === "all" ? "any items"
    : items.length === 1 ? nm(items[0]) : `${items.length} ${scope === "collections" ? "collections" : "products"}`
  let head: string
  if (kind === "shipping") head = "Free delivery on the order"
  else if (kind === "bxgy") {
    const off = d.type === "percent" ? (d.value >= 100 ? "free" : `at ${d.value}% off`) : `at ${taka(d.value)} off each`
    head = `Buy ${d.buyQty ?? "?"} from ${list(d.buyScope ?? "all", d.buyItems ?? [], buyNames ?? label)}, get ${d.getQty ?? "?"} from ${list(d.scope, d.items, label)} ${off}`
    if (d.maxUses) head += ` · ${d.maxUses}× per order`
  } else {
    const off = d.type === "percent" ? `${d.value}% off` : `${taka(d.value)} off`
    const what = d.scope === "all" ? (kind === "order" ? "the order" : "everything")
      : d.items.length === 1 ? label(d.items[0])
      : `${d.items.length} ${d.scope === "collections" ? "collections" : "products"}`
    head = `${off} ${what}`
  }
  return [
    head,
    d.minSubtotal ? `min ${taka(d.minSubtotal)}` : "",
    d.minQty ? `min ${d.minQty} items` : "",
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
