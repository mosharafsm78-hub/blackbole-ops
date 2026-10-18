import { Phone, MessageCircle, Copy } from "lucide-react"
import { toast } from "sonner"
import { STATUS_LABEL, type OrderStatus } from "@/convex/rules"
import { STATUS_TONE, TAG_TONE, TONE_CLASS, telLink, waLink, type Tone } from "@/lib/format"
import { cn } from "@/lib/utils"

export function Pill({ tone, children, className }: { tone: Tone; children: React.ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap", TONE_CLASS[tone], className)}>
      {children}
    </span>
  )
}

export function StatusPill({ status }: { status: string }) {
  const s = status as OrderStatus
  return <Pill tone={STATUS_TONE[s] ?? "gray"}>{STATUS_LABEL[s] ?? status}</Pill>
}

export function TagPill({ tag }: { tag: string }) {
  return <Pill tone={TAG_TONE[tag] ?? "gray"}>{tag}</Pill>
}

export function PageHeader({ title, sub, children }: { title: string; sub?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {sub && <p className="mt-0.5 text-sm text-muted-foreground">{sub}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  )
}

export function Stat({ label, value, hint, tone }: { label: string; value: React.ReactNode; hint?: React.ReactNode; tone?: Tone }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className={cn("mt-1 text-2xl font-semibold tabular-nums", tone && TONE_CLASS[tone].split(" ")[1])}>{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
    </div>
  )
}

export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed bg-card px-6 py-14 text-center">
      <div className="font-medium">{title}</div>
      {children && <div className="max-w-md text-sm text-muted-foreground">{children}</div>}
    </div>
  )
}

export function Loading() {
  return <div className="py-16 text-center text-sm text-muted-foreground">Loading…</div>
}

export function ContactButtons({ phone, onCall }: { phone: string; onCall?: () => void }) {
  return (
    <span className="inline-flex items-center gap-1">
      <a
        href={telLink(phone)}
        onClick={onCall}
        title="Call"
        className="inline-flex size-7 items-center justify-center rounded-md border bg-background hover:bg-accent"
      >
        <Phone className="size-3.5" />
      </a>
      <a
        href={waLink(phone)}
        target="_blank"
        rel="noreferrer"
        title="WhatsApp"
        className="inline-flex size-7 items-center justify-center rounded-md border bg-background text-tone-green hover:bg-accent"
      >
        <MessageCircle className="size-3.5" />
      </a>
      <button
        type="button"
        title="Copy number"
        onClick={() => {
          navigator.clipboard.writeText(phone)
          toast.success("Number copied")
        }}
        className="inline-flex size-7 items-center justify-center rounded-md border bg-background hover:bg-accent"
      >
        <Copy className="size-3.5" />
      </button>
    </span>
  )
}
