// Website sub-navigation, laid out like the Shopify Admin left menu:
// main items with an icon, and their sub-items indented under them while that part is open.
import { Link } from "@tanstack/react-router"
import { BadgePercent, FileText, Store, Tag, Users } from "lucide-react"
import { cn } from "@/lib/utils"

export type WebsiteNavKey =
  | "products" | "collections" | "inventory" | "reviews"
  | "discounts"
  | "content" | "files" | "menus" | "blog" | "pages"
  | "store" | "themes" | "preferences"
  | "customers" | "subscribers"

type Sub = { key: WebsiteNavKey; label: string; to: string; search?: Record<string, string> }
type Item = Sub & { icon: typeof Tag; subs: Sub[] }

// `/website-inventory` is added by another page; the link works once that page exists.
export const WEBSITE_NAV: Item[] = [
  {
    key: "products", label: "Products", to: "/website", search: { tab: "products", view: "live" }, icon: Tag,
    subs: [
      { key: "collections", label: "Collections", to: "/website-collections" },
      { key: "inventory", label: "Inventory", to: "/website-inventory" },
      { key: "reviews", label: "Reviews", to: "/website-reviews" },
    ],
  },
  { key: "discounts", label: "Discounts", to: "/website-discounts", icon: BadgePercent, subs: [] },
  {
    key: "content", label: "Content", to: "/website-files", icon: FileText,
    subs: [
      { key: "files", label: "Files", to: "/website-files" },
      { key: "menus", label: "Menus", to: "/website-navigation" },
      { key: "blog", label: "Blog posts", to: "/website-blog" },
      { key: "pages", label: "Pages", to: "/website-pages" },
    ],
  },
  {
    key: "store", label: "Online Store", to: "/website-themes", icon: Store,
    subs: [
      { key: "themes", label: "Themes", to: "/website-themes" },
      { key: "preferences", label: "Preferences", to: "/website-settings" },
    ],
  },
  {
    key: "customers", label: "Customers", to: "/website-subscribers", icon: Users,
    subs: [{ key: "subscribers", label: "Subscribers", to: "/website-subscribers" }],
  },
]

/** Which Website menu entry a page belongs to (null when not a Website page). */
export function websiteNavKey(path: string, search: Record<string, unknown> = {}): WebsiteNavKey | null {
  const p = path.replace(/\/+$/, "") || "/"
  if (p === "/website") return search.tab === "collections" ? "collections" : "products"
  if (!p.startsWith("/website-")) return null
  const page = p.slice("/website-".length)
  switch (page) {
    case "product": case "new": return "products"
    case "collection": case "collections": return "collections"
    case "inventory": return "inventory"
    case "reviews": return "reviews"
    case "discounts": case "discount": return "discounts"
    case "files": return "files"
    case "navigation": return "menus"
    case "blog": case "post": return "blog"
    case "pages": case "page": return "pages"
    case "themes": case "theme-editor": return "themes"
    case "settings": return "preferences"
    case "subscribers": return "subscribers"
    default: return null
  }
}

/** The main item (Products, Content, …) a key sits under. */
export function websiteNavParent(key: WebsiteNavKey): WebsiteNavKey {
  for (const it of WEBSITE_NAV) if (it.key === key || it.subs.some((s) => s.key === key)) return it.key
  return key
}

/** Indented menu shown under "Website" in the Ops sidebar while a Website page is open. */
export function WebsiteSubNav({ active, onNavigate }: { active: WebsiteNavKey | null; onNavigate?: () => void }) {
  const parent = active ? websiteNavParent(active) : null
  return (
    <div className="mb-1 mt-0.5 space-y-px pl-3" data-testid="website-subnav">
      {WEBSITE_NAV.map((it) => {
        const open = parent === it.key
        // Like Shopify: the main item is highlighted only when you are on its own page;
        // on a sub-page the sub-item is highlighted and the main item turns bold.
        const self = active === it.key
        return (
          <div key={it.key}>
            <NavRow to={it.to} search={it.search} onNavigate={onNavigate} active={self} bold={open}>
              <it.icon className={cn("size-4 shrink-0", open ? "text-foreground" : "text-muted-foreground")} />
              {it.label}
            </NavRow>
            {open && it.subs.length > 0 && (
              <div className="space-y-px py-0.5">
                {it.subs.map((s) => (
                  <NavRow key={s.key} to={s.to} search={s.search} onNavigate={onNavigate} active={active === s.key} sub>
                    {s.label}
                  </NavRow>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function NavRow({ to, search, active, bold, sub, onNavigate, children }: {
  to: string; search?: Record<string, string>; active?: boolean; bold?: boolean; sub?: boolean; onNavigate?: () => void; children: React.ReactNode
}) {
  return (
    <Link
      // routes are typed; this menu is data-driven (and one page is added by another change), so loosen it here
      to={to as "/website"}
      search={search as never}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-8 items-center gap-2 rounded-lg px-2 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
        sub && "pl-8 h-7",
        bold && "font-semibold text-foreground",
        active && "bg-accent font-semibold text-foreground",
      )}
    >
      {children}
    </Link>
  )
}
