import { cloneElement, createContext, useContext, useEffect, useRef, useState } from "react"
import { Link, useNavigate, useRouterState } from "@tanstack/react-router"
import { useAuthActions } from "@convex-dev/auth/react"
import { Authenticated, AuthLoading, Unauthenticated, useAction, useMutation, useQuery } from "convex/react"
import { toast } from "sonner"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import {
  BarChart3, Wallet, LayoutDashboard, ShoppingBag, PlusCircle, Package, Boxes, PackagePlus, Users, Settings, LogOut, KeyRound, Menu, ShoppingCart, Search, Truck, Upload, ScanLine, Lock, Globe, MessageCircle, Target, ShieldAlert, Trophy,
} from "lucide-react"
import { api } from "@/convex/_generated/api"
import { hasPerm } from "@/convex/rules"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet"
import { Toaster } from "@/components/ui/sonner"
import { cn } from "@/lib/utils"
import { SignInForm } from "@/components/sign-in-form"
import { WebsiteSubNav, websiteNavKey } from "@/components/website-nav"

type Me = { name: string; email: string; roleName: string; perms: string[] }
const MeContext = createContext<Me | null>(null)
export function useMe() {
  const me = useContext(MeContext)
  if (!me) throw new Error("useMe outside AppShell")
  return me
}
export function useCan() {
  const me = useMe()
  return (perm: string) => hasPerm(me.perms, perm)
}

const NAV = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, perm: "dashboard.view", color: "bg-tone-blue-bg text-tone-blue", group: "" },
  { to: "/action-center", label: "Action Center", icon: Target, perm: "dashboard.view", color: "bg-tone-violet-bg text-tone-violet", group: "" },
  { to: "/accountability", label: "Accountability", icon: ShieldAlert, perm: "orders.view", color: "bg-tone-red-bg text-tone-red", group: "" },
  { to: "/leaderboard", label: "Leaderboard", icon: Trophy, perm: "dashboard.view", color: "bg-tone-amber-bg text-tone-amber", group: "" },
  { to: "/orders", label: "Orders", icon: ShoppingBag, perm: "orders.view", color: "bg-tone-amber-bg text-tone-amber", group: "Orders" },
  { to: "/new-order", label: "New order", icon: PlusCircle, perm: "orders.create", color: "bg-tone-green-bg text-tone-green", group: "Orders" },
  { to: "/abandoned", label: "Abandoned carts", icon: ShoppingCart, perm: "orders.view", color: "bg-tone-red-bg text-tone-red", group: "Orders" },
  { to: "/scan", label: "Scan", icon: ScanLine, perm: "orders.view", color: "bg-tone-indigo-bg text-tone-indigo", group: "Orders" },
  { to: "/customers", label: "Customers", icon: Users, perm: "orders.view", color: "bg-tone-pink-bg text-tone-pink", group: "Orders" },
  { to: "/whatsapp", label: "WhatsApp", icon: MessageCircle, perm: "orders.view", color: "bg-tone-green-bg text-tone-green", group: "Orders" },
  { to: "/products", label: "Products", icon: Package, perm: "orders.view", color: "bg-tone-violet-bg text-tone-violet", group: "Stock" },
  { to: "/inventory", label: "Inventory", icon: Boxes, perm: "orders.view", color: "bg-tone-teal-bg text-tone-teal", group: "Stock" },
  { to: "/website", label: "Website", icon: Globe, perm: "website.manage", alt: "settings.manage", color: "bg-tone-blue-bg text-tone-blue", group: "Stock" },
  { to: "/purchases", label: "Purchases & stock in", icon: PackagePlus, perm: "inventory.receive", color: "bg-tone-orange-bg text-tone-orange", group: "Stock" },
  { to: "/reports", label: "Reports", icon: BarChart3, perm: "reports.view", color: "bg-tone-cyan-bg text-tone-cyan", group: "Insights" },
  { to: "/dispatch", label: "Dispatch report", icon: Truck, perm: "orders.view", color: "bg-tone-indigo-bg text-tone-indigo", group: "Insights" },
  { to: "/courier-payments", label: "Pathao payments", icon: Wallet, perm: "orders.view", color: "bg-tone-green-bg text-tone-green", group: "Insights" },
  { to: "/delivery-partners", label: "Delivery partners", icon: Truck, perm: "partners.manage", color: "bg-tone-red-bg text-tone-red", group: "Setup" },
  { to: "/settings", label: "Settings", icon: Settings, perm: "settings.manage", color: "bg-tone-gray-bg text-tone-gray", group: "Setup" },
  { to: "/import", label: "Data import", icon: Upload, perm: "team.manage", color: "bg-tone-gray-bg text-tone-gray", group: "Setup" },
] as const

function Brand() {
  return (
    <div className="flex items-center gap-2 px-2">
      <div className="flex size-8 items-center justify-center rounded-md bg-foreground text-sm font-bold text-background">BB</div>
      <div className="leading-tight">
        <div className="text-sm font-semibold">BlackBole Ops</div>
        <div className="text-[11px] text-muted-foreground">Orders & stock</div>
      </div>
    </div>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-sm rounded-xl border bg-card p-6 shadow-sm">{children}</div>
    </div>
  )
}

function SignIn() {
  return <SignInForm brand={<Brand />} />
}

function Gate({ children }: { children: React.ReactNode }) {
  const me = useQuery(api.team.me)
  const claim = useMutation(api.team.claim)
  const { signOut } = useAuthActions()
  const tried = useRef(false)
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (me?.kind === "noAccess" && !tried.current) {
      tried.current = true
      claim({}).catch(() => {})
    }
  }, [me?.kind, claim])

  if (me === undefined) return <Centered><p className="text-sm text-muted-foreground">Loading…</p></Centered>
  if (me.kind === "signedOut") return <SignIn />
  if (me.kind === "firstRun") {
    return (
      <Centered>
        <Brand />
        <h1 className="mt-6 text-lg font-semibold">Set up BlackBole Ops</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          You're the first person here, so you'll be the Super Admin. You can invite the team from Settings.
        </p>
        <form
          className="mt-5 space-y-3"
          onSubmit={async (e) => {
            e.preventDefault()
            setBusy(true)
            await claim({ name }).finally(() => setBusy(false))
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="name">Your name</Label>
            <Input id="name" value={name} onChange={(e) => setName(e.target.value)} required placeholder="Emon" />
          </div>
          <Button type="submit" className="w-full" disabled={busy}>Start</Button>
        </form>
      </Centered>
    )
  }
  if (me.kind === "noAccess" || me.kind === "waiting" || me.kind === "rejected" || me.kind === "disabled") {
    const waiting = me.kind === "waiting"
    return (
      <Centered>
        <Brand />
        <h1 className="mt-6 text-lg font-semibold">
          {me.kind === "rejected" ? "Access not approved" : me.kind === "disabled" ? "Your access is turned off" : waiting ? "Waiting for approval" : "Request access"}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {me.kind === "rejected" ? `${me.email} was not approved. Talk to your admin if this is a mistake.`
            : me.kind === "disabled" ? "An admin turned off your access. Talk to your admin."
            : waiting ? `Thanks${me.name ? `, ${me.name}` : ""}! An admin will approve ${me.email} and give you your team's access. This page opens by itself once approved.`
            : `${me.email} isn't on the team yet. Write your name and ask for access.`}
        </p>
        {(me.kind === "noAccess" || (waiting && !me.name)) && (
          <form
            className="mt-5 space-y-3"
            onSubmit={async (e) => { e.preventDefault(); setBusy(true); await claim({ name }).finally(() => setBusy(false)) }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="rname">Your name</Label>
              <Input id="rname" value={name} onChange={(e) => setName(e.target.value)} required placeholder="e.g. Injamam" />
            </div>
            <Button type="submit" className="w-full" disabled={busy}>Request access</Button>
          </form>
        )}
        <Button variant="outline" className="mt-3 w-full" onClick={() => signOut()}>Sign out</Button>
      </Centered>
    )
  }
  return (
    <MeContext.Provider value={{ name: me.staff.name, email: me.staff.email, roleName: me.roleName, perms: me.perms }}>
      {children}
    </MeContext.Provider>
  )
}

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const me = useMe()
  const path = useRouterState({ select: (s) => s.location.pathname })
  const search = useRouterState({ select: (s) => s.location.search }) as Record<string, unknown>
  const inWebsite = path === "/website" || path.startsWith("/website-")
  const carts = useQuery(api.checkouts.counts)
  const orderCounts = useQuery(api.orders.counts)
  const flagCounts = useQuery(api.accountability.openCounts)
  const badge = (to: string) => (to === "/abandoned" && carts ? carts.new + carts.followupDue : to === "/orders" && orderCounts ? orderCounts.pending ?? 0 : to === "/accountability" && flagCounts ? flagCounts.total : 0)
  return (
    <nav className="space-y-0.5">
      {NAV.map((n, i) => {
        const Icon = n.icon
        const heading = n.group && n.group !== NAV[i - 1]?.group
          ? <div key={`g-${n.group}`} className="px-2.5 pb-1 pt-4 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">{n.group}</div>
          : null
        if (!hasPerm(me.perms, n.perm) && !("alt" in n && hasPerm(me.perms, n.alt))) {
          return [heading, (
            <div key={n.to} title="Locked — ask your admin for access" className="flex cursor-not-allowed items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm font-medium text-muted-foreground/50">
              <span className="flex size-7 items-center justify-center rounded-md bg-muted"><Icon className="size-4" /></span>{n.label}<Lock className="ml-auto size-3.5" />
            </div>
          )]
        }
        const active = n.to === "/" ? path === "/" : path.startsWith(n.to) || (n.to === "/orders" && path.startsWith("/order")) || (n.to === "/purchases" && /^\/(purchase|supplier|stock-in)/.test(path))
        // Website opens in place, Shopify-style: its own menu shows indented under it.
        const expanded = n.to === "/website" && inWebsite
        return [heading, (
          <Link
            key={n.to}
            to={n.to}
            onClick={onNavigate}
            className={cn(
              "flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
              active && (expanded ? "font-semibold text-foreground" : "bg-accent font-semibold text-foreground"),
            )}
          >
            <span className={cn("flex size-7 items-center justify-center rounded-md", n.color)}><Icon className="size-4" /></span>
            {n.label}
            {badge(n.to) > 0 && <span className={cn("ml-auto rounded-full px-1.5 text-[11px] font-semibold tabular-nums text-white", n.to === "/orders" ? "bg-tone-amber" : "bg-tone-red")} title={n.to === "/orders" ? "Pending orders" : undefined}>{badge(n.to)}</span>}
          </Link>
        ), expanded ? <WebsiteSubNav key="website-sub" active={websiteNavKey(path, search)} onNavigate={onNavigate} /> : null]
      })}
    </nav>
  )
}

function Layout({ children }: { children: React.ReactNode }) {
  const me = useMe()
  const { signOut } = useAuthActions()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState("")

  const side = (
    <div className="flex min-h-full flex-col gap-6 p-3">
      <Brand />
      <NavLinks onNavigate={() => setOpen(false)} />
      <div className="mt-auto border-t pt-3">
        <div className="px-2 text-sm font-medium">{me.name}</div>
        <div className="px-2 text-xs text-muted-foreground">{me.roleName}</div>
        <ChangePassword />
        <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => signOut()}>
          <LogOut className="size-4" /> Sign out
        </Button>
      </div>
    </div>
  )

  return (
    <div className="min-h-screen bg-canvas">
      <aside className="no-print fixed inset-y-0 left-0 hidden w-56 overflow-y-auto overscroll-contain border-r bg-card lg:block">{side}</aside>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="left" className="w-64 overflow-y-auto p-0">
          <SheetTitle className="sr-only">Menu</SheetTitle>
          {side}
        </SheetContent>
      </Sheet>
      <div className="lg:pl-56">
        <header className="no-print sticky top-0 z-30 flex h-14 items-center gap-3 border-b bg-card/90 px-4 backdrop-blur">
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setOpen(true)} aria-label="Open menu">
            <Menu className="size-5" />
          </Button>
          <QuickSearch q={q} setQ={setQ} />
        </header>
        {/* No max-width cap: pages that want to stay narrow (Action Center, settings forms, etc.) already wrap
            themselves in their own `mx-auto max-w-*` — this just stops wide pages (Orders, Dashboard) from
            being stranded in a fixed-width column with dead space on either side on a big monitor. */}
        <main className="w-full p-4 md:p-6">{children}</main>
      </div>
    </div>
  )
}

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <AuthLoading>
        <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-canvas px-6" data-testid="app-loading">
          <img src="/blackbole-logo.png" alt="BlackBole" className="w-56 max-w-[70vw] animate-pulse dark:invert" />
          <div className="h-1 w-40 overflow-hidden rounded-full bg-muted">
            <div className="h-full w-1/3 animate-[bbload_1.1s_ease-in-out_infinite] rounded-full bg-foreground" />
          </div>
          <style>{"@keyframes bbload{0%{transform:translateX(-110%)}100%{transform:translateX(320%)}}"}</style>
        </div>
      </AuthLoading>
      <Unauthenticated>
        <SignIn />
      </Unauthenticated>
      <Authenticated>
        <Gate>
          <Layout>{children}</Layout>
        </Gate>
      </Authenticated>
      <Toaster richColors position="top-right" />
    </>
  )
}

/** Renders children only for users with the permission. */
export function Guard({ perm, children }: { perm: string; children: React.ReactNode }) {
  const me = useMe()
  if (!hasPerm(me.perms, perm)) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-lg border bg-card p-10 text-center text-sm text-muted-foreground">
        <Lock className="size-6" />
        <div className="font-medium text-foreground">This page is locked for you</div>
        <div>Your admin can switch it on in Settings → Team.</div>
      </div>
    )
  }
  return <>{children}</>
}

/** Website pages: open with "website.manage" or "settings.manage". */
export function WebsiteGuard({ children }: { children: React.ReactNode }) {
  const me = useMe()
  return <Guard perm={hasPerm(me.perms, "website.manage") ? "website.manage" : "settings.manage"}>{children}</Guard>
}

/**
 * Wrap a button that needs a permission. Allowed → shown as is.
 * Not allowed → same button, greyed out with a lock, and it does nothing.
 */
export function Perm({ perm, children }: { perm: string; children: React.ReactElement<any> }) {
  const me = useMe()
  if (hasPerm(me.perms, perm)) return children
  return cloneElement(children, {
    disabled: true,
    onClick: undefined,
    href: undefined,
    asChild: false,
    title: "Locked — ask your admin for access",
    "data-locked": "true",
    className: cn(children.props.className, "cursor-not-allowed opacity-60"),
    children: <><Lock className="size-3.5" />{lockLabel(children.props.children)}</>,
  })
}

function lockLabel(c: React.ReactNode): React.ReactNode {
  // If the button wraps a link (asChild), show the link's text instead of the link.
  const el = c as React.ReactElement<any>
  if (el && typeof el === "object" && "props" in el && (el.type === "a" || (el.props && el.props.to))) return el.props.children
  return c
}

/** Sidebar: change your own password (asks for the current one). */
function ChangePassword() {
  const change = useAction(api.account.changePassword)
  const [open, setOpen] = useState(false)
  const [cur, setCur] = useState("")
  const [next, setNext] = useState("")
  const [again, setAgain] = useState("")
  const [busy, setBusy] = useState(false)
  const reset = () => { setCur(""); setNext(""); setAgain("") }
  return (
    <>
      <Button variant="ghost" size="sm" className="mt-2 w-full justify-start" onClick={() => setOpen(true)} data-testid="change-password">
        <KeyRound className="size-4" /> Change password
      </Button>
      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset() }}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Change password</DialogTitle></DialogHeader>
          <form
            className="space-y-3"
            onSubmit={async (e) => {
              e.preventDefault()
              if (next !== again) { toast.error("The two new passwords are not the same"); return }
              setBusy(true)
              try {
                await change({ current: cur, next })
                toast.success("Password changed. Use the new one next time you sign in.")
                setOpen(false); reset()
              } catch (err) {
                const m = (err as any)?.data ?? (err instanceof Error ? err.message : String(err))
                toast.error(typeof m === "string" ? m : "Could not change the password")
              } finally { setBusy(false) }
            }}
          >
            <div className="space-y-1.5"><Label htmlFor="cp-cur">Current password</Label><Input id="cp-cur" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} required /></div>
            <div className="space-y-1.5"><Label htmlFor="cp-new">New password</Label><Input id="cp-new" type="password" autoComplete="new-password" minLength={8} value={next} onChange={(e) => setNext(e.target.value)} required /><p className="text-xs text-muted-foreground">At least 8 characters.</p></div>
            <div className="space-y-1.5"><Label htmlFor="cp-again">New password again</Label><Input id="cp-again" type="password" autoComplete="new-password" minLength={8} value={again} onChange={(e) => setAgain(e.target.value)} required /></div>
            <DialogFooter><Button type="submit" disabled={busy}>{busy ? "Saving…" : "Change password"}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}

/** Top search box: results show while typing (like Nuport); Enter opens the full list. */
function QuickSearch({ q, setQ }: { q: string; setQ: (v: string) => void }) {
  const navigate = useNavigate()
  const [term, setTerm] = useState("")
  const [open, setOpen] = useState(false)
  useEffect(() => { const t = setTimeout(() => setTerm(q.trim()), 250); return () => clearTimeout(t) }, [q])
  const results = useQuery(api.orders.search, term.length >= 3 ? { term } : "skip")
  const show = open && term.length >= 3
  const go = (id: string) => { setOpen(false); setQ(""); navigate({ to: "/order", search: { id } }) }
  return (
    <form
      className="relative w-full max-w-md"
      onSubmit={(e) => {
        e.preventDefault()
        if (results && results.length === 1) return go(results[0]._id)
        if (q.trim()) { setOpen(false); navigate({ to: "/orders", search: { tab: "all", q: q.trim() } }) }
      }}
    >
      <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={q} onChange={(e) => { setQ(e.target.value); setOpen(true) }} onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 200)} onKeyDown={(e) => { if (e.key === "Escape") setOpen(false) }}
        placeholder="Find order: invoice, phone, name, consignment…" className="pl-8" data-testid="quick-search"
      />
      {show && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-96 overflow-auto rounded-xl border bg-popover p-1 shadow-lg" data-testid="quick-search-results">
          {results === undefined ? <div className="p-3 text-sm text-muted-foreground">Searching…</div>
            : results.length === 0 ? <div className="p-3 text-sm text-muted-foreground">No order found for “{term}”</div>
            : (
              <>
                <div className="px-3 pb-1 pt-2 text-xs text-muted-foreground">{results.length} result{results.length > 1 ? "s" : ""} for “{term}”</div>
                {results.slice(0, 8).map((o) => (
                  <button
                    key={o._id} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => go(o._id)}
                    className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left hover:bg-accent"
                  >
                    <span className="min-w-0">
                      <span className="block font-semibold text-tone-blue">{o.invoiceCode ?? `BB-${o.invoiceNo}`}{o.externalName ? <span className="ml-2 text-xs font-normal text-muted-foreground">{o.externalName}</span> : null}</span>
                      <span className="block truncate text-sm">{o.customerName} · <span className="tabular-nums text-muted-foreground">{o.phone}</span></span>
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">{STATUS_LABEL_SHORT[o.status] ?? o.status}</span>
                  </button>
                ))}
                {results.length > 8 && (
                  <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => { setOpen(false); navigate({ to: "/orders", search: { tab: "all", q: term } }) }} className="w-full rounded-lg px-3 py-2 text-left text-sm font-medium hover:bg-accent">See all {results.length} →</button>
                )}
              </>
            )}
        </div>
      )}
    </form>
  )
}

const STATUS_LABEL_SHORT: Record<string, string> = {
  pending: "Pending", on_hold: "On Hold", approved: "Approved", processing: "Processing", ready_to_ship: "Ready To Ship", in_transit: "In Transit",
  delivered_due: "Delivered · Due", delivered_paid: "Delivered · Paid", pending_returned: "Pending Return", returned: "Returned", damaged: "Damaged", cancelled: "Cancelled",
}
