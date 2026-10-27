import { useEffect, useRef, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery } from "convex/react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { Guard } from "@/components/app-shell"
import { Loading, PageHeader } from "@/components/bits"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { dateTime, errMsg } from "@/lib/format"
import { cn } from "@/lib/utils"

export const Route = createFileRoute("/_app/whatsapp")({
  component: () => (
    <Guard perm="orders.view">
      <WhatsAppPage />
    </Guard>
  ),
})

function WhatsAppPage() {
  const threads = useQuery(api.whatsapp.threads)
  const [active, setActive] = useState<Id<"waThreads"> | null>(null)
  useEffect(() => { if (!active && threads && threads.length > 0) setActive(threads[0]._id) }, [threads, active])

  return (
    <div className="flex h-[calc(100vh-7rem)] flex-col">
      <PageHeader title="WhatsApp" sub="Customer chats on BlackBole's WhatsApp number — separate from your team's regular WhatsApp Business app." />
      <div className="flex min-h-0 flex-1 gap-4">
        <div className="w-full max-w-xs shrink-0 overflow-y-auto rounded-xl border bg-card">
          {!threads ? <Loading /> : threads.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No conversations yet. Connect WhatsApp in Settings, or simulate one there to try the inbox.</p>
          ) : (
            <div className="divide-y">
              {threads.map((t) => (
                <button key={t._id} type="button" onClick={() => setActive(t._id)}
                  className={cn("flex w-full flex-col items-start gap-0.5 px-3 py-2.5 text-left text-sm hover:bg-accent", active === t._id && "bg-accent")}>
                  <span className="flex w-full items-center justify-between gap-2">
                    <span className="truncate font-medium">{t.name}</span>
                    {t.unread && <span className="size-2 shrink-0 rounded-full bg-tone-green" />}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">{t.lastDirection === "out" ? "You: " : ""}{t.lastText || "—"}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex min-h-0 flex-1 flex-col rounded-xl border bg-card">
          {active ? <Conversation threadId={active} /> : <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Select a conversation</div>}
        </div>
      </div>
    </div>
  )
}

function Conversation({ threadId }: { threadId: Id<"waThreads"> }) {
  const messages = useQuery(api.whatsapp.messages, { threadId })
  const reply = useMutation(api.whatsapp.reply)
  const openThread = useMutation(api.whatsapp.openThread)
  const [text, setText] = useState("")
  const bottomRef = useRef<HTMLDivElement>(null)
  useEffect(() => { void openThread({ threadId }) }, [threadId, openThread])
  useEffect(() => { bottomRef.current?.scrollIntoView({ block: "end" }) }, [messages?.length])

  const send = async () => {
    const clean = text.trim()
    if (!clean) return
    setText("")
    try { await reply({ threadId, text: clean }) } catch (e) { toast.error(errMsg(e)) }
  }

  return (
    <>
      <div className="flex-1 space-y-2 overflow-y-auto p-4">
        {!messages ? <Loading /> : messages.length === 0 ? (
          <p className="text-sm text-muted-foreground">No messages yet.</p>
        ) : (
          messages.map((m) => (
            <div key={m._id} className={cn("flex", m.direction === "out" ? "justify-end" : "justify-start")}>
              <div className={cn("max-w-[75%] rounded-2xl px-3 py-2 text-sm", m.direction === "out" ? "bg-tone-green-bg text-foreground" : "bg-muted")}>
                <div>{m.text}</div>
                <div className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground">
                  {dateTime(m.at)}{m.by ? ` · ${m.by}` : ""}
                  {m.status === "failed" && <span className="font-semibold text-tone-red">· failed{m.error ? `: ${m.error}` : ""}</span>}
                  {m.status === "queued" && <span>· sending…</span>}
                </div>
              </div>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
      <div className="flex gap-2 border-t p-3">
        <Input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void send() }} placeholder="Type a reply…" />
        <Button onClick={() => void send()}>Send</Button>
      </div>
    </>
  )
}
