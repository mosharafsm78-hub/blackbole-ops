// Accountability: once a return call confirms a reason was really our own fault, the department that caused
// it gets a flag it has to answer — inside this ops system, not a side chat nobody can trace later. See
// ACCOUNTABILITY_ROUTING in rules.ts for which department owns which reason, and Settings → Accountability for
// who, by name, currently owns each department (so a flag lands on an actual person, not just a bucket) and
// who the operations head is (gets pinged if something sits open past 2 days — see overdue/escalate below).
import { v, ConvexError } from "convex/values"
import { query, internalQuery, internalAction, type MutationCtx } from "./_generated/server"
import { mutation, internalMutation } from "./functions"
import { internal } from "./_generated/api"
import { requirePerm, invoiceLabel, logOrder, notify, getSetting, setSetting } from "./lib"
import { ACCOUNTABILITY_ROUTING } from "./rules"
import { bdDay, statsFromDays } from "./stats"
import type { Doc } from "./_generated/dataModel"

const DAY = 86400000
const SLA_DAYS = 2

/** The real departments a case can be routed to. Kept in step with the team tags the UI shows (CX / OPS / MKT /
 *  DEV) so a re-route can only ever pick a department the rest of the app knows how to label. */
export const DEPARTMENTS = ["Customer Care", "Fulfillment", "Marketing", "Development"]

type Owners = { byTeam: Record<string, { name: string; email: string }>; opsHead?: { name: string; email: string } }

async function ownersConf(ctx: MutationCtx | any): Promise<Owners> {
  return (await getSetting<Owners>(ctx, "accountabilityOwners")) ?? { byTeam: {} }
}

/** Called from logReturnCsat once a return call outcome is logged. Raises one open flag for the owning
 *  department — if one's already open for this order (e.g. the call was re-logged by a Super Admin), it's
 *  reused rather than duplicated, so a department never sees the same order twice in its queue. Looks up the
 *  named owner for that team (Settings → Accountability) and emails them right away, on top of the in-app flag. */
export async function raiseAccountabilityFlag(ctx: MutationCtx, order: Doc<"orders">, outcome: string, note: string | undefined, byName: string) {
  const team = ACCOUNTABILITY_ROUTING[outcome]
  if (!team) return // not an at-fault reason with an owning department (e.g. "Customer changed mind")
  const owners = await ownersConf(ctx)
  const owner = owners.byTeam[team]
  const existing = await ctx.db.query("opsFlags").withIndex("by_order", (q) => q.eq("orderId", order._id)).filter((q) => q.eq(q.field("status"), "open")).first()
  let flagId
  if (existing) {
    await ctx.db.patch(existing._id, { reason: outcome, team, note, raisedByName: byName, raisedAt: Date.now(), assignee: owner?.name, assigneeEmail: owner?.email, escalatedAt: undefined })
    flagId = existing._id
  } else {
    flagId = await ctx.db.insert("opsFlags", { orderId: order._id, reason: outcome, team, note, status: "open", raisedByName: byName, raisedAt: Date.now(), assignee: owner?.name, assigneeEmail: owner?.email })
  }
  await logOrder(ctx, order._id, `Accountability: ${outcome} — flagged to ${owner ? `${owner.name} (${team})` : team}`, byName)
  await notify(ctx, `${owner?.name ?? team}: ${outcome}`, `${invoiceLabel(order)} needs a response from ${owner?.name ?? team} before this can close out.`, order._id, "accountability")
  await sendFlagEmailOnce(ctx, flagId, {
    team,
    owner,
    subject: `Accountability: ${invoiceLabel(order)} needs your answer`,
    body: `Hi {first},\n\n${invoiceLabel(order)} (${order.customerName}, ${order.phone}) came back with: "${outcome}"${note ? ` — note from the call: "${note}"` : ""}.\n\nThis is routed to you as ${team}. Please open it in Ops → Accountability and write what happened, within ${SLA_DAYS} days.\n\n— BlackBole Ops`,
  })
  return flagId
}

/** A lead address we can actually send to. Deliberately strict: a typo'd address must be recorded as skipped,
 *  not handed to the mailer to bounce silently. */
export function isValidEmail(email: string | undefined | null): email is string {
  return !!email && /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email.trim())
}

/** The one place a department-lead flag email is ever queued, so the "never twice" rule lives in a single spot.
 *
 *  Idempotency: `flagEmailSentAt` is written in the SAME mutation that schedules the send, before the action
 *  runs. Re-flagging the same case, or a double-click, therefore finds the latch already set and returns
 *  without scheduling a second email. A missing or malformed lead address is recorded on the flag
 *  (`flagEmailSkippedReason`) and never throws — the flag itself is already raised and must not be undone by
 *  an email problem. */
async function sendFlagEmailOnce(
  ctx: MutationCtx,
  flagId: Doc<"opsFlags">["_id"],
  opts: { team: string; owner?: { name: string; email: string }; subject: string; body: string },
) {
  const flag = await ctx.db.get(flagId)
  if (!flag) return
  if (flag.flagEmailSentAt) return // already emailed once — never a second time
  const { team, owner } = opts
  if (!owner) {
    await ctx.db.patch(flagId, { flagEmailAttemptedAt: Date.now(), flagEmailSkippedReason: `No lead is set for ${team} in Settings → Accountability.` })
    return
  }
  if (!isValidEmail(owner.email)) {
    await ctx.db.patch(flagId, { flagEmailAttemptedAt: Date.now(), flagEmailSkippedReason: `Lead for ${team} has no valid email address on file.` })
    return
  }
  const now = Date.now()
  await ctx.db.patch(flagId, { flagEmailSentAt: now, flagEmailAttemptedAt: now, flagEmailSkippedReason: undefined, flagEmailTo: owner.email.trim() })
  await ctx.scheduler.runAfter(0, internal.emailNode.sendAccountabilityEmail, {
    to: owner.email.trim(),
    subject: opts.subject,
    text: opts.body.replace("{first}", owner.name.split(" ")[0] || "there"),
  })
}

/** Work out who to email for a (now re-routed) case, and whether we can.
 *
 *  Order of precedence: the named assignee if the team setting points at that person, then the assignee's own
 *  staff record (so "switch the lead to Rafi" reaches Rafi, not just whoever holds the department), then the
 *  department's configured lead. Returns a reason instead of throwing when nothing usable is found — a re-route
 *  must never fail because an address is missing. */
async function resolveLead(ctx: MutationCtx | any, team: string, assigneeName?: string): Promise<{ lead?: { name: string; email: string }; note?: string }> {
  const owners = await ownersConf(ctx)
  const byTeam = owners.byTeam?.[team]
  if (assigneeName) {
    if (byTeam && byTeam.name.trim().toLowerCase() === assigneeName.trim().toLowerCase()) {
      return isValidEmail(byTeam.email) ? { lead: byTeam } : { note: `${team} lead ${byTeam.name} has no valid email address on file.` }
    }
    const person = (await ctx.db.query("staff").collect()).find((s: any) => s.active && s.name.trim().toLowerCase() === assigneeName.trim().toLowerCase())
    if (person) return isValidEmail(person.email) ? { lead: { name: person.name, email: person.email } } : { note: `${person.name} has no valid email address on file.` }
    // Named a person who isn't on the team: fall through to the department lead rather than silently dropping.
    if (!byTeam) return { note: `“${assigneeName}” isn't on the team, and no lead is set for ${team}.` }
  }
  if (!byTeam) return { note: `No lead is set for ${team} in Settings → Accountability.` }
  return isValidEmail(byTeam.email) ? { lead: byTeam } : { note: `Lead for ${team} has no valid email address on file.` }
}

/** Saju (or whoever's set as the operations head) opening a question that isn't tied to one order — "why is
 *  our return ratio high this month", a pattern across several orders, anything that needs a named answer.
 *  Same flag, same mandatory-response, same 2-day SLA as an order-triggered one. */
export const raiseFreeform = mutation({
  args: { team: v.string(), question: v.string() },
  handler: async (ctx, { team, question }) => {
    const me = await requirePerm(ctx, "team.manage")
    const q = question.trim()
    if (!q) throw new ConvexError("Write the question before raising it.")
    const owners = await ownersConf(ctx)
    const owner = owners.byTeam[team]
    const id = await ctx.db.insert("opsFlags", { reason: q, team, status: "open", raisedByName: me.staff.name, raisedAt: Date.now(), assignee: owner?.name, assigneeEmail: owner?.email })
    await notify(ctx, `${owner?.name ?? team}: question raised`, q, undefined, "accountability")
    await sendFlagEmailOnce(ctx, id, {
      team,
      owner,
      subject: `Accountability: a question needs your answer`,
      body: `Hi {first},\n\n${me.staff.name} raised this in Accountability, routed to you as ${team}:\n\n"${q}"\n\nPlease open it in Ops → Accountability and answer, within ${SLA_DAYS} days.\n\n— BlackBole Ops`,
    })
    return id
  },
})

/** The open flag on one order, if any — shown as a banner on the order page. */
export const openForOrder = query({
  args: { orderId: v.id("orders") },
  handler: async (ctx, { orderId }) => {
    return await ctx.db.query("opsFlags").withIndex("by_order", (q) => q.eq("orderId", orderId)).filter((q) => q.eq(q.field("status"), "open")).first()
  },
})

/** How many flags are open right now, broken down by department — drives the dashboard tile per team. */
export const openCounts = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("opsFlags").withIndex("by_status", (q) => q.eq("status", "open")).collect()
    const byTeam: Record<string, number> = {}
    for (const r of rows) byTeam[r.team] = (byTeam[r.team] ?? 0) + 1
    return { total: rows.length, byTeam }
  },
})

/** Every open flag, newest first, with enough order context to act on it without a second click. Free-form
 *  questions (no orderId) carry orderInvoice: null instead. */
export const listOpen = query({
  args: {},
  handler: async (ctx) => {
    await requirePerm(ctx, "orders.view")
    const rows = await ctx.db.query("opsFlags").withIndex("by_status", (q) => q.eq("status", "open")).order("desc").collect()
    const out: any[] = []
    for (const r of rows) {
      if (r.orderId) {
        const o = await ctx.db.get(r.orderId)
        if (!o) continue
        out.push({ ...r, orderInvoice: invoiceLabel(o), orderStatus: o.status, customerName: o.customerName, phone: o.phone })
      } else {
        out.push({ ...r, orderInvoice: null })
      }
    }
    return out
  },
})

const MIN_CAPA_CHARS = 15

/** A department closes its own flag with a CAPA answer (Corrective & Preventive Action — the standard format
 *  for this across manufacturing and retail ops): what actually went wrong, what was done about this case, and
 *  what concretely changes so it doesn't happen again. All three are required and checked for real substance
 *  (not "fixed it" or "ok") — this is the record of whether the team actually improved, not just closed a ticket. */
export const respond = mutation({
  args: { id: v.id("opsFlags"), rootCause: v.string(), correctiveAction: v.string(), preventiveAction: v.string() },
  handler: async (ctx, a) => {
    const me = await requirePerm(ctx, "orders.accountability")
    const flag = await ctx.db.get(a.id)
    if (!flag) throw new ConvexError("Flag not found")
    if (flag.status !== "open") throw new ConvexError("Already resolved")
    const rootCause = a.rootCause.trim(), correctiveAction = a.correctiveAction.trim(), preventiveAction = a.preventiveAction.trim()
    if (rootCause.length < MIN_CAPA_CHARS) throw new ConvexError("Write what actually went wrong — a real reason, not a one-liner.")
    if (correctiveAction.length < MIN_CAPA_CHARS) throw new ConvexError("Write what was actually done about this specific case.")
    if (preventiveAction.length < MIN_CAPA_CHARS) throw new ConvexError("Write the concrete change that stops this happening again — not a promise, an action.")
    const response = `Root cause: ${rootCause}\nFix: ${correctiveAction}\nPrevention: ${preventiveAction}`
    await ctx.db.patch(a.id, { status: "resolved", response, rootCause, correctiveAction, preventiveAction, resolvedByName: me.staff.name, resolvedAt: Date.now(), closedAt: Date.now() })
    if (flag.orderId) await logOrder(ctx, flag.orderId, `Accountability resolved by ${flag.team}: ${response}`, me.staff.name)
  },
})

// ---------------------------------------------------------------------------------------------------------------
// Closed cases: the read-only history of everything that has left the open queue — answered with a CAPA, or
// archived as a duplicate/invalid case. Nothing here can be edited; the only action is restoring an archived
// case back to the open queue, which is itself recorded.
// ---------------------------------------------------------------------------------------------------------------

/** Soft-archive a case that shouldn't be answered — a duplicate, a test entry, a flag raised against the wrong
 *  order. Never a hard delete: the record, its reason and its history all stay, so the audit trail is intact.
 *  Idempotent, so a double-click is a no-op rather than an error. */
export const archive = mutation({
  args: { id: v.id("opsFlags"), reason: v.optional(v.string()) },
  handler: async (ctx, { id, reason }) => {
    const me = await requirePerm(ctx, "orders.accountability")
    const flag = await ctx.db.get(id)
    if (!flag) throw new ConvexError("Case not found")
    if (flag.archivedAt) return { alreadyArchived: true }
    if (flag.status === "resolved") throw new ConvexError("This case is already closed with an answer — it can't be archived.")
    const now = Date.now()
    await ctx.db.patch(id, {
      status: "archived",
      archivedAt: now,
      archivedBy: me.staff.name,
      archiveReason: reason?.trim() || undefined,
      closedAt: now,
    })
    if (flag.orderId) await logOrder(ctx, flag.orderId, `Accountability case archived by ${me.staff.name}${reason?.trim() ? ` — ${reason.trim()}` : ""}`, me.staff.name)
    return { alreadyArchived: false }
  },
})

/** Put an archived case back in the open queue — the undo for a mistaken archive. Clears the archive fields and
 *  the closed stamp so it behaves exactly like a freshly raised flag again. */
export const unarchive = mutation({
  args: { id: v.id("opsFlags") },
  handler: async (ctx, { id }) => {
    const me = await requirePerm(ctx, "orders.accountability")
    const flag = await ctx.db.get(id)
    if (!flag) throw new ConvexError("Case not found")
    if (!flag.archivedAt) return { alreadyOpen: true }
    await ctx.db.patch(id, { status: "open", archivedAt: undefined, archivedBy: undefined, archiveReason: undefined, closedAt: undefined })
    if (flag.orderId) await logOrder(ctx, flag.orderId, `Accountability case restored to the open queue by ${me.staff.name}`, me.staff.name)
    return { alreadyOpen: false }
  },
})

/** Super Admin edit / re-route of an open case.
 *
 *  Fixes the two mistakes that used to force an archive-and-recreate (losing the original history): a case
 *  raised against the wrong department, and a typo in the title or the explanation note.
 *
 *  The caller sends the full desired state (team, assignee, title, note), which makes "nothing changed" a
 *  simple value comparison — a genuine no-op returns early and writes no audit entry and sends no email, so
 *  a double-click can never pad the history.
 *
 *  Re-notification reuses the Task-5 latch: when (and only when) the department or the named assignee actually
 *  changes, the stale `flagEmailSentAt` is cleared so the new lead can be reached exactly once. The old lead is
 *  never re-emailed, and submitting the same re-route twice is a no-op — no second email. */
export const rerouteOpsFlag = mutation({
  args: {
    id: v.id("opsFlags"),
    team: v.string(),
    assignee: v.optional(v.string()),
    reason: v.string(),
    note: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const me = await requirePerm(ctx, "orders.accountability")
    // Super Admin holds the wildcard; everyone else may answer cases but not rewrite their history.
    if (!me.perms.includes("*")) throw new ConvexError("Only a Super Admin can edit or re-route a case.")

    const flag = await ctx.db.get(a.id)
    if (!flag) throw new ConvexError("Case not found")
    if (flag.archivedAt || flag.status === "archived") throw new ConvexError("This case is archived — restore it first if it needs fixing.")
    if (flag.status !== "open") throw new ConvexError("This case is already closed — its history is final and can't be edited.")

    const team = a.team.trim()
    const reason = a.reason.trim()
    const note = a.note?.trim() || undefined
    const assignee = a.assignee?.trim() || undefined
    if (!team) throw new ConvexError("Pick the department this case belongs to.")
    if (!reason) throw new ConvexError("The issue title can't be empty.")

    // Compare against what's actually on the record (legacy rows may have neither field set).
    const prevTeam = flag.team ?? ""
    const prevAssignee = flag.assignee ?? undefined
    const prevNote = flag.note ?? undefined
    const changed: string[] = []
    if (team !== prevTeam) changed.push("department")
    if ((assignee ?? "") !== (prevAssignee ?? "")) changed.push("assignee")
    if (reason !== flag.reason) changed.push("title")
    if ((note ?? "") !== (prevNote ?? "")) changed.push("note")

    if (!changed.length) return { changed: [], emailed: false, noop: true }

    const now = Date.now()
    const rerouted = changed.includes("department") || changed.includes("assignee")

    // Resolve the new owner before writing, so the record and the audit note agree.
    const { lead, note: leadProblem } = rerouted ? await resolveLead(ctx, team, assignee) : { lead: undefined, note: undefined }

    const history = [...(flag.rerouteHistory ?? []), {
      editedAt: now, editedBy: me.staff.name,
      previousTeam: prevTeam, newTeam: team,
      previousAssignee: prevAssignee, newAssignee: assignee,
      changed,
      emailNote: rerouted ? (lead ? undefined : leadProblem) : undefined,
    }]

    await ctx.db.patch(a.id, {
      team,
      reason,
      note,
      assignee,
      // A re-route must reach the NEW lead: clear the Task-5 latch so exactly one email goes out to them.
      // Assignee email follows the new owner, so the daily digest lands in the right inbox too.
      ...(rerouted ? { assigneeEmail: lead?.email, flagEmailSentAt: undefined, flagEmailSkippedReason: undefined, flagEmailAttemptedAt: undefined, flagEmailTo: undefined } : {}),
      previousTeam: prevTeam,
      newTeam: team,
      previousAssignee: prevAssignee,
      newAssignee: assignee,
      editedAt: now,
      editedBy: me.staff.name,
      rerouteHistory: history,
    })

    let emailed = false
    if (rerouted) {
      if (lead) {
        // sendFlagEmailOnce patches the flag itself, so it must run on the post-patch document — the cleared
        // latch above is exactly what lets this one email through.
        await sendFlagEmailOnce(ctx, a.id, {
          team,
          owner: lead,
          subject: `Accountability: ${reason} — re-routed to you`,
          body: `Hi {first},\n\nThis case has been re-routed to you as ${team} by ${me.staff.name}${changed.includes("department") ? ` (was ${prevTeam})` : ""}:\n\n"${reason}"${note ? `\n\nNote: "${note}"` : ""}\n\nPlease open it in Ops → Accountability and write what happened, within ${SLA_DAYS} days.\n\n— BlackBole Ops`,
        })
        emailed = true
      } else {
        // Recorded on the flag, never thrown — a missing address must not block the correction itself.
        await ctx.db.patch(a.id, { flagEmailAttemptedAt: now, flagEmailSkippedReason: leadProblem })
        await notify(ctx, `${assignee ?? team}: case re-routed`, `${reason} — ${leadProblem}`, flag.orderId, "accountability")
      }
    }

    if (flag.orderId) {
      const bits = [changed.includes("department") ? `${prevTeam} → ${team}` : null, changed.includes("assignee") ? `${prevAssignee ?? "unassigned"} → ${assignee ?? "unassigned"}` : null].filter(Boolean)
      await logOrder(ctx, flag.orderId, `Accountability case edited by ${me.staff.name} (${changed.join(", ")})${bits.length ? ` — ${bits.join(", ")}` : ""}`, me.staff.name)
    }

    return { changed, emailed, noop: false, skippedEmailBecause: rerouted && !lead ? leadProblem : undefined }
  },
})

/** Who a case can be re-routed to: the configured lead for each department, plus every active staff member, so
 *  a Super Admin can switch the assignee to a named person (e.g. MKT → OPS, lead → Rafi). Read-only and gated
 *  on plain view rights, because it only returns names/emails already shown across Settings. Departments with
 *  no lead still appear, with lead: null, so the picker never silently hides a team. */
export const assigneeChoices = query({
  args: {},
  handler: async (ctx) => {
    await requirePerm(ctx, "orders.view")
    const owners = await ownersConf(ctx)
    const staff = await ctx.db.query("staff").collect()
    const departments = Object.keys(ACCOUNTABILITY_ROUTING).map((k) => ACCOUNTABILITY_ROUTING[k])
    const teams = [...new Set([...DEPARTMENTS, ...departments, ...Object.keys(owners.byTeam ?? {})])]
    return {
      teams: teams.sort(),
      byTeam: Object.fromEntries(teams.map((t) => [t, owners.byTeam?.[t] ?? null])),
      people: staff.filter((s) => s.active).map((s) => ({ name: s.name, email: s.email })).sort((a, b) => a.name.localeCompare(b.name)),
    }
  },
})

/** The Closed Cases history, newest close first. Read-only: every row carries who closed it, when, why, and the
 *  linked order so the case can be reviewed without leaving the page. Legacy flags that were resolved before
 *  `closedAt` existed fall back to `resolvedAt`, so old history still appears rather than silently vanishing. */
export const listClosed = query({
  args: { team: v.optional(v.string()) },
  handler: async (ctx, { team }) => {
    await requirePerm(ctx, "orders.view")
    const rows = await ctx.db.query("opsFlags").withIndex("by_status", (q) => q.eq("status", "resolved")).order("desc").collect()
    const archived = await ctx.db.query("opsFlags").withIndex("by_status", (q) => q.eq("status", "archived")).order("desc").collect()
    const all = [...rows, ...archived].filter((r) => !team || r.team === team)
    const out: any[] = []
    for (const r of all) {
      let orderInvoice: string | null = null
      let orderStatus: string | null = null
      let customerName: string | null = null
      let phone: string | null = null
      if (r.orderId) {
        const o = await ctx.db.get(r.orderId)
        if (o) {
          orderInvoice = invoiceLabel(o)
          orderStatus = o.status
          customerName = o.customerName
          phone = o.phone
        }
      }
      out.push({
        ...r,
        orderInvoice,
        orderStatus,
        customerName,
        phone,
        // One sortable "when it closed" for both kinds of closure, with a fallback for pre-Task-5 records.
        closedAtResolved: r.closedAt ?? r.archivedAt ?? r.resolvedAt ?? r.raisedAt,
        outcome: r.archivedAt ? "archived" : "answered",
      })
    }
    out.sort((a, b) => b.closedAtResolved - a.closedAtResolved)
    return out
  },
})

// ---------------------------------------------------------------------------------------------------------------
// Settings → Accountability: who owns each team's flags by name, and who the operations head is.
// ---------------------------------------------------------------------------------------------------------------

export const ownersSettings = query({
  args: {},
  handler: async (ctx) => {
    await requirePerm(ctx, "team.manage")
    return await ownersConf(ctx)
  },
})

export const saveOwners = mutation({
  args: {
    byTeam: v.record(v.string(), v.object({ name: v.string(), email: v.string() })),
    opsHead: v.optional(v.object({ name: v.string(), email: v.string() })),
  },
  handler: async (ctx, a) => {
    await requirePerm(ctx, "team.manage")
    await setSetting(ctx, "accountabilityOwners", a)
  },
})

// ---------------------------------------------------------------------------------------------------------------
// Daily reminders: a daily cron (see crons.ts) emails every owner one digest of their own still-open items —
// from day 1, not just once overdue — and separately pings the operations head about anything past the 2-day
// SLA, every day it stays open, so nothing quietly sits unanswered.
// ---------------------------------------------------------------------------------------------------------------

export const openForDigest = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("opsFlags").withIndex("by_status", (q) => q.eq("status", "open")).collect()
    const owners = await ownersConf(ctx)
    const out: any[] = []
    for (const r of rows) {
      let orderInvoice: string | null = null
      if (r.orderId) {
        const o = await ctx.db.get(r.orderId)
        if (o) orderInvoice = invoiceLabel(o)
      }
      out.push({
        _id: r._id, reason: r.reason, team: r.team, raisedAt: r.raisedAt, orderInvoice,
        assignee: r.assignee, assigneeEmail: r.assigneeEmail,
      })
    }
    return { rows: out, opsHead: owners.opsHead }
  },
})

export const markEscalated = internalMutation({
  args: { id: v.id("opsFlags") },
  handler: async (ctx, { id }) => {
    await ctx.db.patch(id, { escalatedAt: Date.now() })
  },
})

function itemLine(r: { reason: string; team: string; orderInvoice: string | null; raisedAt: number }) {
  const days = Math.floor((Date.now() - r.raisedAt) / DAY)
  return `- ${r.orderInvoice ? `${r.orderInvoice} — ` : ""}"${r.reason}" (${r.team}, open ${days} day${days === 1 ? "" : "s"})`
}

/** Runs daily (see crons.ts). Every owner with open items gets one email listing all of them, every day they
 *  stay open — not just once they cross the SLA. Anything 2+ days old also gets a separate digest to the
 *  operations head, so they can chase it personally. */
export const checkOverdue = internalAction({
  args: {},
  handler: async (ctx) => {
    const { rows, opsHead } = await ctx.runQuery(internal.accountability.openForDigest, {})
    if (!rows.length) return

    type Group = { name: string; items: any[] }
    const byAssignee = new Map<string, Group>()
    const overdue: any[] = []
    for (const r of rows) {
      if (r.assigneeEmail) {
        const g: Group = byAssignee.get(r.assigneeEmail) ?? { name: r.assignee ?? "", items: [] }
        g.items.push(r)
        byAssignee.set(r.assigneeEmail, g)
      }
      if (Date.now() - r.raisedAt >= SLA_DAYS * DAY) overdue.push(r)
    }

    for (const [email, g] of byAssignee) {
      const lines = g.items.map(itemLine).join("\n")
      await ctx.runAction(internal.emailNode.sendAccountabilityEmail, {
        to: email,
        subject: `Accountability: ${g.items.length} pending item${g.items.length === 1 ? "" : "s"} need${g.items.length === 1 ? "s" : ""} your answer`,
        text: `Hi ${g.name.split(" ")[0] || "there"},\n\nStill open and waiting on you:\n\n${lines}\n\nPlease close these out in Ops → Accountability.\n\n— BlackBole Ops`,
      })
    }

    if (opsHead?.email && overdue.length) {
      const lines = overdue.map(itemLine).join("\n")
      await ctx.runAction(internal.emailNode.sendAccountabilityEmail, {
        to: opsHead.email,
        subject: `Accountability: ${overdue.length} item${overdue.length === 1 ? "" : "s"} past the 2-day SLA`,
        text: `Hi ${opsHead.name.split(" ")[0]},\n\nThese have been open 2+ days with no answer:\n\n${lines}\n\nWorth a direct chase.\n\n— BlackBole Ops`,
      })
      for (const r of overdue) await ctx.runMutation(internal.accountability.markEscalated, { id: r._id })
    }
  },
})

// ---------------------------------------------------------------------------------------------------------------
// Business-health flags: not every accountability item should wait for a customer-care call. A daily check
// (see crons.ts) looks at the whole business — sales trend, return ratio — the way an operations head would,
// and raises a flag against the department that actually owns that outcome even when no one logged a call.
// Thresholds are deliberately blunt for now (no historical baseline to calibrate against yet); the point is
// catching the two things that most directly cost BlackBole money — fewer sales, more returns — not every
// metric that could move.
// ---------------------------------------------------------------------------------------------------------------

const SALES_DROP_PCT = -15 // week-over-week % change that counts as "sales dropping"
const RETURN_RATIO_HIGH = 0.15 // 15%+ of resolved orders returned/damaged in a week counts as "high" on its own
const RETURN_RATIO_JUMP = 0.05 // or a 5-percentage-point jump over the previous week, even if not yet at 15%

export const openByTeam = internalQuery({
  args: { team: v.string() },
  handler: async (ctx, { team }) => {
    return await ctx.db.query("opsFlags").withIndex("by_team_status", (q) => q.eq("team", team).eq("status", "open")).collect()
  },
})

/** Same as raiseFreeform, but for the system itself to open a flag — no signed-in staff member to attribute it
 *  to, so it's logged as BlackBole Ops (automatic) and skips the team.manage permission check accordingly. */
export const raiseSystem = internalMutation({
  args: { team: v.string(), reason: v.string(), note: v.optional(v.string()) },
  handler: async (ctx, { team, reason, note }) => {
    const owners = await ownersConf(ctx)
    const owner = owners.byTeam[team]
    const id = await ctx.db.insert("opsFlags", { reason, team, note, status: "open", raisedByName: "BlackBole Ops (automatic)", raisedAt: Date.now(), assignee: owner?.name, assigneeEmail: owner?.email })
    await notify(ctx, `${owner?.name ?? team}: business metric needs an answer`, reason, undefined, "accountability")
    await sendFlagEmailOnce(ctx, id, {
      team,
      owner,
      subject: `Accountability: a business metric needs your answer`,
      body: `Hi {first},\n\nBlackBole Ops spotted this automatically and routed it to you as ${team}:\n\n"${reason}"${note ? `\n\n${note}` : ""}\n\nPlease open it in Ops → Accountability and answer, within ${SLA_DAYS} days.\n\n— BlackBole Ops`,
    })
    return id
  },
})

/** Runs daily (see crons.ts), comparing a rolling 7-day window to the 7 days before it — daily so a real
 *  problem is caught within a day, but still a week wide so one unusual day doesn't trigger a false alarm.
 *  Uses the same scoreboard the dashboard reads from (cheap — no re-scanning every order). Raises at most one
 *  open flag per metric per team at a time: if yesterday's flag on the same thing is still open, it isn't
 *  piled on again — the daily digest already keeps reminding the owner. */
export const businessHealthCheck = internalAction({
  args: {},
  handler: async (ctx) => {
    const now = Date.now()
    const WEEK = 7 * DAY
    const [thisRows, prevRows] = await Promise.all([
      ctx.runQuery(internal.stats.days, { fromDay: bdDay(now - WEEK), toDay: bdDay(now) }),
      ctx.runQuery(internal.stats.days, { fromDay: bdDay(now - 2 * WEEK), toDay: bdDay(now - WEEK) }),
    ])
    const t = statsFromDays(thisRows, now - WEEK, now)
    const p = statsFromDays(prevRows, now - 2 * WEEK, now - WEEK)

    const alreadyOpen = async (team: string, tag: string) => {
      const rows = await ctx.runQuery(internal.accountability.openByTeam, { team })
      return rows.some((r: any) => (r.reason as string).startsWith(tag))
    }

    // Sales dropping week over week
    if (p.totalSales > 0) {
      const pct = Math.round(((t.totalSales - p.totalSales) / p.totalSales) * 100)
      if (pct <= SALES_DROP_PCT) {
        const tag = "[Business health] Sales down"
        if (!(await alreadyOpen("Marketing", tag))) {
          await ctx.runMutation(internal.accountability.raiseSystem, {
            team: "Marketing",
            reason: `${tag} ${Math.abs(pct)}% this week`,
            note: `৳${Math.round(t.totalSales).toLocaleString()} this week vs ৳${Math.round(p.totalSales).toLocaleString()} last week (${t.totalOrders} vs ${p.totalOrders} orders). What's driving it, and what's the plan to turn it back up?`,
          })
        }
      }
    }

    // Return ratio climbing, or just high
    const tResolved = t.delivered + t.returned
    const pResolved = p.delivered + p.returned
    const tRatio = tResolved > 0 ? t.returned / tResolved : null
    const pRatio = pResolved > 0 ? p.returned / pResolved : null
    if (tRatio !== null && (tRatio >= RETURN_RATIO_HIGH || (pRatio !== null && tRatio - pRatio >= RETURN_RATIO_JUMP))) {
      const tag = "[Business health] Return ratio high"
      if (!(await alreadyOpen("Fulfillment", tag))) {
        await ctx.runMutation(internal.accountability.raiseSystem, {
          team: "Fulfillment",
          reason: `${tag} — ${Math.round(tRatio * 100)}% this week`,
          note: `${t.returned} returned/damaged out of ${tResolved} resolved orders this week${pRatio !== null ? ` (was ${Math.round(pRatio * 100)}% last week)` : ""}. Find the main driver — if it turns out to really be a listing/description mismatch rather than a fulfillment error, re-route it to Marketing instead of answering it here.`,
        })
      }
    }
  },
})
