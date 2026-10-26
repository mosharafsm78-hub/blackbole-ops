// Shared bits for Website → Pages, Blog, Navigation and Settings (same look as the other Website pages).
import { useState } from "react"
import { useAction } from "convex/react"
import { Download, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import { WebsiteTabs, type WebsiteTab } from "@/components/discount-ui"
import { Button } from "@/components/ui/button"
import { errMsg } from "@/lib/format"

export function WebsiteHeader({ active, sub, children }: { active: WebsiteTab; sub: string; children?: React.ReactNode }) {
  return (
    <>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Website</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">{sub}</p>
        </div>
        <div className="flex items-center gap-2">{children}</div>
      </div>
      <WebsiteTabs active={active} />
    </>
  )
}

type What = "all" | "pages" | "posts" | "menus" | "redirects" | "settings"
const LABEL: Record<What, string> = { all: "everything", pages: "pages", posts: "blog posts", menus: "menus", redirects: "redirects", settings: "settings" }

/** One-time copy of what the website shows today, so nothing is lost when Ops takes over. Safe to repeat. */
export function ImportButton({ what, variant = "outline", label }: { what: What; variant?: "outline" | "default"; label?: string }) {
  const run = useAction(api.content.importContent)
  const [busy, setBusy] = useState(false)
  return (
    <Button size="sm" variant={variant} disabled={busy} onClick={async () => {
      setBusy(true)
      try {
        const r = await run({ what })
        const parts = Object.entries(r).map(([k, n]) => `${n} ${k}`)
        toast.success(`Copied from the website: ${parts.join(", ")}`)
      } catch (e) { toast.error(errMsg(e)) } finally { setBusy(false) }
    }}>
      {busy ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}{label ?? `Copy ${LABEL[what]} from the current website`}
    </Button>
  )
}

export function EmptyImport({ icon, title, text, what, children }: { icon: React.ReactNode; title: string; text: string; what: What; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed bg-card px-6 py-16 text-center">
      <div className="flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground">{icon}</div>
      <div className="font-medium">{title}</div>
      <p className="max-w-md text-sm text-muted-foreground">{text}</p>
      <div className="flex flex-wrap justify-center gap-2"><ImportButton what={what} variant="default" />{children}</div>
    </div>
  )
}

export function ago(t: number) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (s < 45) return "just now"
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  return new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
}
