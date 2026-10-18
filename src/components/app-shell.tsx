import { cloneElement, createContext, useContext, useEffect, useRef, useState } from "react"
import { Link, useNavigate, useRouterState } from "@tanstack/react-router"
import { useAuthActions } from "@convex-dev/auth/react"
import { Authenticated, AuthLoading, Unauthenticated, useMutation, useQuery } from "convex/react"
import {
  LayoutDashboard, ShoppingBag, PlusCircle, Package, Boxes, PackagePlus, Users, Settings, LogOut, Menu, Search, Truck, Upload, ScanLine, Lock,
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
  { to: "/", label: "Dashboard", icon: LayoutDashboard, perm: "dashboard.view" },
  { to: "/orders", label: "Orders", icon: ShoppingBag, perm: "orders.view" },
  { to: "/new-order", label: "New order", icon: PlusCircle, perm: "orders.create" },
  { to: "/scan", label: "Scan", icon: ScanLine, perm: "orders.view" },
  { to: "/products", label: "Products", icon: Package, perm: "orders.view" },
  { to: "/inventory", label: "Inventory", icon: Boxes, perm: "orders.view" },
  { to: "/purchases", label: "Purchases & stock in", icon: PackagePlus, perm: "inventory.receive" },
  { to: "/customers", label: "Customers", icon: Users, perm: "orders.view" },
  { to: "/delivery-partners", label: "Delivery partners", icon: Truck, perm: "partners.manage" },
  { to: "/settings", label: "Settings", icon: Settings, perm: "settings.manage" },
  { to: "/import", label: "Data import", icon: Upload, perm: "team.manage" },
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
  return (
    <nav className="space-y-0.5">
      {NAV.map((n) => {
        const Icon = n.icon
        if (!hasPerm(me.perms, n.perm)) {
          return (
            <div key={n.to} title="Locked — ask your admin for access" className="flex cursor-not-allowed items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium text-muted-foreground/50">
              <Icon className="size-4" />{n.label}<Lock className="ml-auto size-3.5" />
            </div>
          )
        }
        const active = n.to === "/" ? path === "/" : path.startsWith(n.to) || (n.to === "/orders" && path.startsWith("/order")) || (n.to === "/purchases" && /^\/(purchase|supplier|stock-in)/.test(path))
        return (
          <Link
            key={n.to}
            to={n.to}
            onClick={onNavigate}
            className={cn(
              "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
              active && "bg-accent text-foreground",
            )}
          >
            <Icon className="size-4" />
            {n.label}
          </Link>
        )
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
    <div className="flex h-full flex-col gap-6 p-3">
      <Brand />
      <NavLinks onNavigate={() => setOpen(false)} />
      <div className="mt-auto border-t pt-3">
        <div className="px-2 text-sm font-medium">{me.name}</div>
        <div className="px-2 text-xs text-muted-foreground">{me.roleName}</div>
        <Button variant="ghost" size="sm" className="mt-2 w-full justify-start" onClick={() => signOut()}>
          <LogOut className="size-4" /> Sign out
        </Button>
      </div>
    </div>
  )

  return (
    <div className="min-h-screen bg-canvas">
      <aside className="no-print fixed inset-y-0 left-0 hidden w-56 border-r bg-card lg:block">{side}</aside>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="left" className="w-64 p-0">
          <SheetTitle className="sr-only">Menu</SheetTitle>
          {side}
        </SheetContent>
      </Sheet>
      <div className="lg:pl-56">
        <header className="no-print sticky top-0 z-30 flex h-14 items-center gap-3 border-b bg-card/90 px-4 backdrop-blur">
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setOpen(true)} aria-label="Open menu">
            <Menu className="size-5" />
          </Button>
          <form
            className="relative w-full max-w-md"
            onSubmit={(e) => {
              e.preventDefault()
              if (q.trim()) navigate({ to: "/orders", search: { tab: "all", q: q.trim() } })
            }}
          >
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find order: invoice, phone, name, consignment…" className="pl-8" />
          </form>
        </header>
        <main className="mx-auto max-w-[1400px] p-4 md:p-6">{children}</main>
      </div>
    </div>
  )
}

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <AuthLoading>
        <Centered><p className="text-sm text-muted-foreground">Checking your session…</p></Centered>
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
