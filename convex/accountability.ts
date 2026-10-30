// Accountability: once a return call confirms a reason was really our own fault, the department that caused
// it gets a flag it has to answer — inside this ops system, not a side chat nobody can trace later. See
// ACCOUNTABILITY_ROUTING in rules.ts for which department owns which reason, and Settings → Accountability for
// who, by name, currently owns each department (so a flag lands on an actual person, not just a bucket) and
// who the operations head is (gets pinged if something sits open past 2 days — see overdue/escalate below).
import { v, ConvexError } from "convex/values"
import { query, internalQuery, internalAction, type MutationCtx } from "./_generated/server"
import { mutation, internalMutation } from "./functions"
import { internal } from "./_generated/api"
import { currentStaff, requirePerm, invoiceLabel, logOrder, notify, getSetting, setSetting } from "./lib"
import { ACCOUNTABILITY_ROUTING, type OrderStatus } from "./rules"
import { bdDay, dayStart, statsFromDays, type DayRow } from "./stats"
import { awardPoints, type KpiRuleKey } from "./kpi"
import type { Doc } from "./_generated/dataModel"

const DAY = 86400000
const SLA_DAYS = 2

/** The real departments a case can be routed to. Kept in step with the team tags the UI shows (CX / OPS / MKT /
 *  DEV) so a re-route can only ever pick a department the rest of the app knows how to label. */
export const DEPARTMENTS = ["Customer Care", "Fulfillment", "Marketing", "Development"]

type Owners = { byTeam: Record<string, { name: string; email: string }>; opsHead?: { name: string; email: string } }

export async function ownersConf(ctx: MutationCtx | any): Promise<Owners> {
  return (await getSetting<Owners>(ctx, "accountabilityOwners")) ?? { byTeam: {} }
}

/** Called from logReturnCsat once a return call outcome is logged. Raises one open flag for the owning
 *  department — if one's already open for this order (e.g. the call was re-logged by a Super Admin), it's
 *  reused rather than duplicated, so a department never sees the same order twice in its queue. Looks up the
 *  named owner for that team (Settings → Accountability) and emails them right away, on top of the in-app flag. */
export async function raiseAccountabilityFlag(ctx: MutationCtx, order: Doc<"orders">, outcome: string, note: string | undefined, byName: string, opts: { ruleKey?: KpiRuleKey } = {}) {
  const team = ACCOUNTABILITY_ROUTING[outcome]
  if (!team) return // not an at-fault reason with an owning department (e.g. "Customer changed mind")
  const owners = await ownersConf(ctx)
  const owner = owners.byTeam[team]
  const existing = await ctx.db.query("opsFlags").withIndex("by_order", (q) => q.eq("orderId", order._id)).filter((q) => q.eq(q.field("status"), "open")).first()
  const productNames = [...new Set(order.items.map((i) => i.name))]
  let flagId
  if (existing) {
    await ctx.db.patch(existing._id, { reason: outcome, team, note, raisedByName: byName, raisedAt: Date.now(), assignee: owner?.name, assigneeEmail: owner?.email, escalatedAt: undefined, productNames })
    flagId = existing._id
  } else {
    flagId = await ctx.db.insert("opsFlags", { orderId: order._id, productNames, reason: outcome, team, note, status: "open", raisedByName: byName, raisedAt: Date.now(), assignee: owner?.name, assigneeEmail: owner?.email })
    // Only on a genuinely new flag — reusing/patching an already-open flag for this order (the "existing"
    // branch above) must not dock the department twice for the same underlying mistake. Callers that have
    // their own named rule for this specific kind of miss (cx.bad_confirmation, say) pass it via opts.ruleKey
    // so it shows up as its own line in the rule book, under its own department, instead of the generic one.
    if (owner?.name) await awardPoints(ctx, { staffName: owner.name, ruleKey: opts.ruleKey ?? "ops.flag_raised", label: `Accountability flag: ${outcome}`, orderId: order._id })
  }
  await logOrder(ctx, order._id, `Accountability: ${outcome} — flagged to ${owner ? `${owner.name} (${team})` : team}`, byName)
  await notify(ctx, `${owner?.name ?? team}: ${outcome}`, `${invoiceLabel(order)} needs a response from ${owner?.name ?? team} before this can close out.`, order._id, "accountability")
  await sendFlagEmailOnce(ctx, flagId, {
    team,
    owner,
    subject: `Accountability: ${invoiceLabel(order)} needs your answer`,
    body: `Hi {first},\n\n${invoiceLabel(order)} (${order.customerName}, ${order.phone}) came back with: "${outcome}"${note ? ` — note from the call: "${note}"` : ""}.\n\nThis is routed to you as ${team}. Please open it in Ops → Accountability and write what happened, within ${SLA_DAYS} days.\n\n— BlackBole Ops`,
  })
  await sendRaiserEmailOnce(ctx, flagId, {
    toName: byName,
    subject: `Accountability: your flag on ${invoiceLabel(order)} was routed to ${owner?.name ?? team}`,
    body: `Hi {first},\n\nYou flagged ${invoiceLabel(order)} (${order.customerName}, ${order.phone}) for "${outcome}". It's been routed to ${owner?.name ?? team} and must be answered within ${SLA_DAYS} days. You'll get another email the moment it's resolved.\n\n— BlackBole Ops`,
  })
  return flagId
}

/** A lead address we can actually send to. Deliberately strict: a typo'd address must be recorded as skipped,
 *  not handed to the mailer to bounce silently. */
export function isValidEmail(email: string | undefined | null): email is string {
  return !!email && /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email.trim())
}

/** Looks up an active staff member's own email by their display name, so the person who raised a flag (not
 *  just the department it was routed to) can be told directly — both when it's raised and when it's resolved. */
async function staffEmailByName(ctx: MutationCtx | any, name: string | undefined): Promise<string | undefined> {
  if (!name) return undefined
  const person = (await ctx.db.query("staff").collect()).find((s: any) => s.active && s.name.trim().toLowerCase() === name.trim().toLowerCase())
  return person && isValidEmail(person.email) ? person.email : undefined
}

/** The one place a "you raised this" confirmation ever goes to the raiser themselves — separate latch from the
 *  department-lead email above, so each side's email is tracked (and never doubled) independently. */
async function sendRaiserEmailOnce(ctx: MutationCtx, flagId: Doc<"opsFlags">["_id"], opts: { toName: string; subject: string; body: string }) {
  const flag = await ctx.db.get(flagId)
  if (!flag) return
  if (flag.raiserEmailSentAt) return
  const email = await staffEmailByName(ctx, opts.toName)
  if (!email) {
    await ctx.db.patch(flagId, { raiserEmailSkippedReason: `${opts.toName} has no valid email address on file.` })
    return
  }
  await ctx.db.patch(flagId, { raiserEmailSentAt: Date.now() })
  await ctx.scheduler.runAfter(0, internal.emailNode.sendAccountabilityEmail, {
    to: email,
    subject: opts.subject,
    text: opts.body.replace("{first}", opts.toName.split(" ")[0] || "there"),
  })
}

/** Resolved notice to BOTH the person who raised the flag and the person/department it was answered by — sent
 *  exactly once, latched on resolvedEmailSentAt so a repeated call (there shouldn't be one — `respond` only
 *  runs on a still-open flag) can never send it twice. */
async function sendResolvedEmails(ctx: MutationCtx, flag: Doc<"opsFlags">, response: string, orderLabel: string | undefined) {
  if (flag.resolvedEmailSentAt) return
  await ctx.db.patch(flag._id, { resolvedEmailSentAt: Date.now() })
  const subject = `Accountability: resolved — ${flag.reason}`
  const bodyFor = (first: string) =>
    `Hi ${first},\n\n${orderLabel ? `${orderLabel} — ` : ""}"${flag.reason}" has been marked resolved${flag.resolvedByName ? ` by ${flag.resolvedByName}` : ""}.\n\n${response}\n\n— BlackBole Ops`
  const raiserEmail = await staffEmailByName(ctx, flag.raisedByName)
  if (raiserEmail) {
    await ctx.scheduler.runAfter(0, internal.emailNode.sendAccountabilityEmail, {
      to: raiserEmail, subject, text: bodyFor(flag.raisedByName.split(" ")[0] || "there"),
    })
  }
  if (isValidEmail(flag.assigneeEmail) && flag.assigneeEmail !== raiserEmail) {
    await ctx.scheduler.runAfter(0, internal.emailNode.sendAccountabilityEmail, {
      to: flag.assigneeEmail, subject, text: bodyFor((flag.assignee ?? "there").split(" ")[0] || "there"),
    })
  }
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
    await sendRaiserEmailOnce(ctx, id, {
      toName: me.staff.name,
      subject: `Accountability: your question was routed to ${owner?.name ?? team}`,
      body: `Hi {first},\n\nYour question was routed to ${owner?.name ?? team}: "${q}". You'll get another email the moment it's answered.\n\n— BlackBole Ops`,
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
        out.push({ ...r, orderInvoice: invoiceLabel(o), orderStatus: o.status, customerName: o.customerName, phone: o.phone, productNames: r.productNames ?? [...new Set(o.items.map((i) => i.name))] })
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
    const order = flag.orderId ? await ctx.db.get(flag.orderId) : null
    await sendResolvedEmails(ctx, { ...flag, resolvedByName: me.staff.name }, response, order ? invoiceLabel(order) : undefined)
    if (Date.now() - flag.raisedAt <= 6 * 3600000) {
      await awardPoints(ctx, { staffName: me.staff.name, ruleKey: "ops.fast_capa", label: `Resolved "${flag.reason}" within 6 hours with a full CAPA answer`, flagId: a.id })
    }
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
    // Anyone trusted to handle accountability flags in the first place (orders.accountability) can also
    // correct one — matches the UI gate in accountability.tsx. requirePerm already covers that permission.
    const me = await requirePerm(ctx, "orders.accountability")

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

    // A true mis-route (the DEPARTMENT was wrong, not just a reassignment within the same team) — docked
    // against whoever raised it in the first place, since picking the department is their call to get right.
    if (changed.includes("department")) {
      await awardPoints(ctx, { staffName: flag.raisedByName, ruleKey: "ops.wrong_route", label: `"${reason}" was re-routed to ${team} (was ${prevTeam})`, flagId: a.id })
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
      let productNames: string[] = r.productNames ?? []
      if (r.orderId) {
        const o = await ctx.db.get(r.orderId)
        if (o) {
          orderInvoice = invoiceLabel(o)
          if (!productNames.length) productNames = [...new Set(o.items.map((i) => i.name))]
        }
      }
      out.push({
        _id: r._id, reason: r.reason, team: r.team, raisedAt: r.raisedAt, orderInvoice, productNames,
        assignee: r.assignee, assigneeEmail: r.assigneeEmail,
      })
    }
    return { rows: out, opsHead: owners.opsHead }
  },
})

export const markEscalated = internalMutation({
  args: { id: v.id("opsFlags") },
  handler: async (ctx, { id }) => {
    const flag = await ctx.db.get(id)
    if (!flag || flag.escalatedAt) return // only once per flag's lifetime — checkOverdue re-lists the same
    // still-open flag every day it stays overdue, so without this guard the dock would re-fire daily too.
    await ctx.db.patch(id, { escalatedAt: Date.now() })
    if (flag.assignee) await awardPoints(ctx, { staffName: flag.assignee, ruleKey: "ops.overdue_flag", label: `"${flag.reason}" sat unanswered past the ${SLA_DAYS}-day SLA`, flagId: id })
  },
})

function itemLine(r: { reason: string; team: string; orderInvoice: string | null; raisedAt: number; productNames?: string[] }) {
  const days = Math.floor((Date.now() - r.raisedAt) / DAY)
  const product = r.productNames?.length ? ` [${r.productNames.join(", ")}]` : ""
  return `- ${r.orderInvoice ? `${r.orderInvoice} — ` : ""}"${r.reason}"${product} (${r.team}, open ${days} day${days === 1 ? "" : "s"})`
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

/** Runs weekly (see crons.ts). Rewards the ops head for a clean week on their own terms — not "nothing went
 *  wrong" (plenty can go wrong that never becomes a flag), but "nothing is currently sitting broken anywhere":
 *  no currently-open flag that's crossed the 2-day SLA, no flag resolved this week that took longer than it to
 *  answer, AND no order currently stuck in Approved or in-transit past the same thresholds businessHealthCheck
 *  itself uses to raise a flag — so this can't call a week "clean" the moment before that flag would fire. */
export const weeklyCleanCheck = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now()
    const since = now - 7 * DAY
    const openNow = await ctx.db.query("opsFlags").withIndex("by_status", (q) => q.eq("status", "open")).collect()
    const anyOpenBreach = openNow.some((f) => now - f.raisedAt >= SLA_DAYS * DAY)

    const resolvedRecently = await ctx.db.query("opsFlags").withIndex("by_status", (q) => q.eq("status", "resolved").gte("raisedAt", since)).collect()
    const anyResolvedBreach = resolvedRecently.some((f) => (f.resolvedAt ?? f.raisedAt) - f.raisedAt > SLA_DAYS * DAY)

    const stuckApproved = await ctx.db.query("orders").withIndex("by_status_changed", (q) => q.eq("status", "approved").lt("statusChangedAt", now - STALE_APPROVED_DAYS * DAY)).first()
    const stuckTransit = await ctx.db.query("orders").withIndex("by_status_changed", (q) => q.eq("status", "in_transit").lt("statusChangedAt", now - STALE_TRANSIT_DAYS * DAY)).first()
    if (anyOpenBreach || anyResolvedBreach || stuckApproved || stuckTransit) return

    const owners = await ownersConf(ctx)
    if (!owners.opsHead?.name) return
    // Idempotency by time window, not orderId (there's no order behind this one) — skip if already awarded
    // once in the last 6 days, so a cron that fires twice in the same week can't double-pay it.
    const already = await ctx.db.query("kpiEvents").withIndex("by_staff", (q) => q.eq("staffName", owners.opsHead!.name).gte("at", now - 6 * DAY)).collect()
    if (already.some((e) => e.ruleKey === "ops.clean_week")) return

    await awardPoints(ctx, {
      staffName: owners.opsHead.name, ruleKey: "ops.clean_week",
      label: `Nothing breached the ${SLA_DAYS}-day SLA, and nothing sat stuck in Approved or transit, this week`,
    })
  },
})

const DELIVERY_RATE_TARGET_DEFAULT = 90 // percent — delivered / (delivered + returned) over the week, editable via Settings → KPI

/** Runs weekly (see crons.ts), looking back at the week just finished. Reuses the exact same weekly
 *  scoreboard businessHealthCheck already reads (dayStats, via statsFromDays), so the number that pays out is
 *  the same number the dashboard shows — never a separately-maintained copy. Deliberately NOT per-order: a
 *  business-wide delivery rate is Saju's own job as Operations Head, the same way a weekly ROAS target is
 *  Marketing's lead's job (see ads.weeklyRoasCheck) — no single order's agent "caused" the week's rate, the
 *  rate itself is the thing the ops head owns and is measured on. */
export const opsDeliveryRateCheck = internalMutation({
  args: {},
  handler: async (ctx) => {
    const owners = await ownersConf(ctx)
    if (!owners.opsHead?.name) return
    const now = Date.now()
    const WEEK = 7 * DAY
    const rows = (await ctx.db.query("dayStats").withIndex("by_day", (q) => q.gte("day", bdDay(now - WEEK)).lte("day", bdDay(now))).collect()) as DayRow[]
    const t = statsFromDays(rows, now - WEEK, now)
    if (t.deliveryRate === null) return // nothing resolved (delivered or returned) yet this week — nothing to score

    const target = (await getSetting<number>(ctx, "opsDeliveryRateTarget")) ?? DELIVERY_RATE_TARGET_DEFAULT
    if (t.deliveryRate < target) return

    // Idempotency by time window, not orderId — same pattern as ops.clean_week / marketing.roas_hit.
    const already = await ctx.db.query("kpiEvents").withIndex("by_staff", (q) => q.eq("staffName", owners.opsHead!.name).gte("at", now - 6 * DAY)).collect()
    if (already.some((e) => e.ruleKey === "ops.delivery_rate_hit")) return

    await awardPoints(ctx, {
      staffName: owners.opsHead.name, ruleKey: "ops.delivery_rate_hit",
      label: `Delivery rate held at ${t.deliveryRate}% this week (target ${target}%)`,
    })
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
const STALE_APPROVED_DAYS = 2 // an approved order that hasn't moved in this long is exactly the "why hasn't this shipped" case fulfillment flagged
const STALE_TRANSIT_DAYS = 4 // a parcel that's shown "in transit" this long without updating is a courier problem worth a human look, not a glitch
const HOTSPOT_WINDOW_DAYS = 14 // how far back to look for a product with repeat at-fault flags
const HOTSPOT_MIN_FLAGS = 3 // this many at-fault flags on the SAME product in the window counts as a pattern, not noise

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
    // Caller (businessHealthCheck) already guards against raising a duplicate open flag for the same signal,
    // so every insert here is a genuinely new flag — safe to dock without an extra "is this new" check.
    if (owner?.name) await awardPoints(ctx, { staffName: owner.name, ruleKey: "ops.flag_raised", label: `Business-health flag: ${reason}`, flagId: id })
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

    // Approved orders sitting untouched past the SLA — the exact "it's in stock, why hasn't it shipped"
    // visibility gap the fulfillment team raised, now caught automatically instead of waiting for someone to
    // notice in the list. Bounded by the by_status_changed index, so this never scans the whole orders table.
    const cutoff = now - STALE_APPROVED_DAYS * DAY
    const stuck = (await ctx.runQuery(internal.accountability.staleInStatus, { status: "approved", cutoff })) as { invoice: string; days: number }[]
    if (stuck.length) {
      const tag = "[Business health] Orders stuck in Approved"
      if (!(await alreadyOpen("Fulfillment", tag))) {
        await ctx.runMutation(internal.accountability.raiseSystem, {
          team: "Fulfillment",
          reason: `${tag} — ${stuck.length} order${stuck.length === 1 ? "" : "s"} not moved in ${STALE_APPROVED_DAYS}+ days`,
          note: stuck.slice(0, 20).map((s) => `- ${s.invoice} — approved ${s.days} day${s.days === 1 ? "" : "s"} ago`).join("\n") + (stuck.length > 20 ? `\n…and ${stuck.length - 20} more.` : "") + "\n\nUse the Pick list on these to see what's actually available to ship right now.",
        })
      }
    }

    // Parcels sitting "in transit" without a courier update in days — the same visibility gap as the stuck
    // Approved check, just one stage later: it's out the door but nobody can tell if the courier lost it.
    const transitCutoff = now - STALE_TRANSIT_DAYS * DAY
    const transitStuck = (await ctx.runQuery(internal.accountability.staleInStatus, { status: "in_transit", cutoff: transitCutoff })) as { invoice: string; days: number }[]
    if (transitStuck.length) {
      const tag = "[Business health] Orders stuck in transit"
      if (!(await alreadyOpen("Fulfillment", tag))) {
        await ctx.runMutation(internal.accountability.raiseSystem, {
          team: "Fulfillment",
          reason: `${tag} — ${transitStuck.length} order${transitStuck.length === 1 ? "" : "s"} with no courier update in ${STALE_TRANSIT_DAYS}+ days`,
          note: transitStuck.slice(0, 20).map((s) => `- ${s.invoice} — in transit ${s.days} day${s.days === 1 ? "" : "s"}`).join("\n") + (transitStuck.length > 20 ? `\n…and ${transitStuck.length - 20} more.` : "") + "\n\nWorth a direct chase with the courier on these — a parcel this old is usually lost, delayed, or needs re-attempting.",
        })
      }
    }

    // A product with repeat at-fault flags (wrong item, damaged, doesn't match description…) in the last two
    // weeks is a pattern, not a one-off call — the kind of thing that's easy to miss case-by-case but obvious
    // once counted. Routed to whichever department most of that product's flags actually went to.
    const hotspots = (await ctx.runQuery(internal.accountability.productHotspots, {
      cutoff: now - HOTSPOT_WINDOW_DAYS * DAY,
    })) as { product: string; team: string; count: number }[]
    for (const h of hotspots.filter((x) => x.count >= HOTSPOT_MIN_FLAGS)) {
      const tag = `[Business health] Repeat issue — ${h.product}`
      if (!(await alreadyOpen(h.team, tag))) {
        await ctx.runMutation(internal.accountability.raiseSystem, {
          team: h.team,
          reason: `${tag} — ${h.count} at-fault flags in the last ${HOTSPOT_WINDOW_DAYS} days`,
          note: `This specific product has come up ${h.count} times in Accountability over the last ${HOTSPOT_WINDOW_DAYS} days, mostly routed to ${h.team}. Worth checking whether it's one bad batch, a listing/description problem, or something about the product itself.`,
        })
      }
    }
  },
})

// ---------------------------------------------------------------------------------------------------------
// Business Health Score — one number out of 100 for "how is BlackBole doing right now", the same idea as
// Amazon's seller Account Health Rating: a handful of pillars, each scored on its own, severity-weighted
// deductions rather than a flat pass/fail, rolled up into one composite — with a hard cap that can override
// the composite when something is seriously wrong, regardless of how good everything else looks (exactly what
// a policy violation does to AHR, whatever the rest of the account looks like). Every input here is a number
// the dashboard, businessHealthCheck's own flags, or the KPI leaderboard already show somewhere else — this
// never invents a new metric, it adds up the ones that already exist and already get acted on.
const HEALTH_WEIGHTS: Record<string, number> = { fulfillment: 0.25, flow: 0.2, quality: 0.2, sales: 0.15, accountability: 0.2 }

export const businessHealth = query({
  args: {},
  handler: async (ctx) => {
    const me = await currentStaff(ctx) // same visibility as the leaderboard — any signed-in staff member
    if (!me) return null
    const now = Date.now()
    const WEEK = 7 * DAY
    const [thisRows, prevRows] = await Promise.all([
      ctx.db.query("dayStats").withIndex("by_day", (q) => q.gte("day", bdDay(now - WEEK)).lte("day", bdDay(now))).collect(),
      ctx.db.query("dayStats").withIndex("by_day", (q) => q.gte("day", bdDay(now - 2 * WEEK)).lte("day", bdDay(now - WEEK))).collect(),
    ])
    const t = statsFromDays(thisRows as DayRow[], now - WEEK, now)
    const p = statsFromDays(prevRows as DayRow[], now - 2 * WEEK, now - WEEK)

    const pillars: { key: string; label: string; score: number; note: string }[] = []
    let hardCap = 100
    let capReason: string | null = null
    const cap = (limit: number, reason: string) => { if (limit < hardCap) { hardCap = limit; capReason = reason } }

    // 1) Delivery reliability — same weekly delivery rate ops.delivery_rate_hit pays out on. No data yet this
    // week isn't a strike against the business, so it scores full marks until there's something to judge.
    const deliveryTarget = (await getSetting<number>(ctx, "opsDeliveryRateTarget")) ?? DELIVERY_RATE_TARGET_DEFAULT
    let fulfillScore = 100
    let fulfillNote = "Not enough delivered/returned orders this week to score yet."
    if (t.deliveryRate !== null) {
      fulfillScore = Math.max(0, 100 - Math.max(0, deliveryTarget - t.deliveryRate) * 3) // 3 pts per point below target
      fulfillNote = `${t.deliveryRate}% delivered vs. returned this week (target ${deliveryTarget}%).`
    }
    pillars.push({ key: "fulfillment", label: "Delivery reliability", score: Math.round(fulfillScore), note: fulfillNote })

    // 2) Order flow — the exact same stuck-Approved / stuck-in-transit counts businessHealthCheck flags and
    // weeklyCleanCheck requires to be zero. Escalates fast on purpose: a handful of stuck orders should hurt.
    const stuckApproved = await ctx.db.query("orders").withIndex("by_status_changed", (q) => q.eq("status", "approved").lt("statusChangedAt", now - STALE_APPROVED_DAYS * DAY)).collect()
    const stuckTransit = await ctx.db.query("orders").withIndex("by_status_changed", (q) => q.eq("status", "in_transit").lt("statusChangedAt", now - STALE_TRANSIT_DAYS * DAY)).collect()
    const stuckCount = stuckApproved.length + stuckTransit.length
    pillars.push({
      key: "flow", label: "Order flow", score: Math.round(Math.max(0, 100 - stuckCount * 15)),
      note: stuckCount === 0 ? "Nothing stuck in Approved or in transit past its SLA." : `${stuckApproved.length} stuck in Approved, ${stuckTransit.length} stuck in transit, past SLA.`,
    })
    if (stuckCount >= 3) cap(70, `${stuckCount} orders stuck past SLA`)

    // 3) Returns & quality — the same return-ratio number the "Return ratio high" flag watches.
    const tResolved = t.delivered + t.returned
    const tRatio = tResolved > 0 ? t.returned / tResolved : null
    let qualityScore = 100
    let qualityNote = "Not enough resolved orders this week to score yet."
    if (tRatio !== null) {
      qualityScore = Math.max(0, 100 - Math.max(0, tRatio - 0.05) * 400) // 4 pts per point above a 5% baseline
      qualityNote = `${Math.round(tRatio * 100)}% of resolved orders were returned/damaged this week.`
    }
    pillars.push({ key: "quality", label: "Returns & quality", score: Math.round(qualityScore), note: qualityNote })
    if (tRatio !== null && tRatio >= RETURN_RATIO_HIGH) cap(75, `Return ratio at ${Math.round(tRatio * 100)}%`)

    // 4) Sales momentum — the same week-over-week sales comparison the "Sales down" flag watches.
    let salesScore = 100
    let salesNote = "Not enough sales history yet to compare weeks."
    if (p.totalSales > 0) {
      const pct = Math.round(((t.totalSales - p.totalSales) / p.totalSales) * 100)
      salesScore = Math.max(0, Math.min(100, 100 + pct * 2)) // 2 pts per % down, 2 pts per % up, capped at 100
      salesNote = `Sales ${pct >= 0 ? "up" : "down"} ${Math.abs(pct)}% week over week (৳${Math.round(t.totalSales).toLocaleString()} vs ৳${Math.round(p.totalSales).toLocaleString()}).`
      if (pct <= SALES_DROP_PCT) cap(80, `Sales down ${Math.abs(pct)}% week over week`)
    }
    pillars.push({ key: "sales", label: "Sales momentum", score: Math.round(salesScore), note: salesNote })

    // 5) Accountability discipline — open flags cost a little each, a flag that's actually breached the SLA
    // costs a lot more, and any live breach caps the whole score — the same severity jump escalatedAt marks.
    const openFlags = await ctx.db.query("opsFlags").withIndex("by_status", (q) => q.eq("status", "open")).collect()
    const breached = openFlags.filter((f) => now - f.raisedAt >= SLA_DAYS * DAY)
    pillars.push({
      key: "accountability", label: "Accountability", score: Math.round(Math.max(0, 100 - openFlags.length * 5 - breached.length * 15)),
      note: openFlags.length === 0 ? "No open accountability flags." : `${openFlags.length} open flag${openFlags.length === 1 ? "" : "s"}, ${breached.length} past the ${SLA_DAYS}-day SLA.`,
    })
    if (breached.length > 0) cap(70, `${breached.length} flag${breached.length === 1 ? "" : "s"} past the SLA`)

    const composite = pillars.reduce((sum, pl) => sum + pl.score * (HEALTH_WEIGHTS[pl.key] ?? 0), 0)
    const score = Math.round(Math.min(composite, hardCap))
    const status = score >= 80 ? "Healthy" : score >= 60 ? "At Risk" : "Needs Attention"

    return { score, status, capReason, pillars, asOf: now }
  },
})

// ---------------------------------------------------------------------------------------------------------
// CX call SLAs — Customer Care's own counterweight. Before this, ACCOUNTABILITY_ROUTING never had a
// "Customer Care" entry at all: ops.flag_raised only ever landed on Fulfillment or Marketing, so a CX agent
// could rack up every reward rule in the book with nothing on the other side of the ledger, no matter how
// badly a call got dropped. These three checks close that gap the exact same way every other department's
// SLA already works — a real per-order accountability flag, through the same opsFlags machinery, docking
// whoever Settings → Accountability names as Customer Care's lead — each with its own named KPI rule key
// (cx.overdue_*) so it shows up as its own line under Customer Care, not a generic "Operations" one.
//
// All three are gated on CX_CALL_SLA_STARTS_AT so turning this on doesn't suddenly flood the queue with flags
// for calls that were already old news before the feature existed — only orders that cross into the relevant
// status from here on are ever counted.
const CX_CALL_SLA_STARTS_AT = dayStart("2026-10-31")
const CONFIRMATION_CALL_SLA_DAYS = 2 // a new order should be confirmed (or otherwise resolved) within this long
const FEEDBACK_CALL_SLA_DAYS = 3 // a delivered order should get its post-delivery feedback call within this long
const RETURN_CALL_SLA_DAYS = 2 // a returned/damaged order should get its return feedback call within this long
const CX_SLA_LOOKBACK_DAYS = 45 // how far back in createdAt the scan bothers looking — plenty for any order to reach any of these stages

/** Brand-new orders sitting unconfirmed (still Pending) past the SLA — the call that was never made, or never
 *  got a real outcome. Bounded directly by createdAt via by_status, since a Pending order's createdAt IS the
 *  moment the clock starts. */
export const overdueConfirmationCallCheck = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now()
    const cutoff = now - CONFIRMATION_CALL_SLA_DAYS * DAY
    const since = now - CX_SLA_LOOKBACK_DAYS * DAY
    const rows = await ctx.db.query("orders").withIndex("by_status", (q) => q.eq("status", "pending").gte("createdAt", since)).collect()
    for (const o of rows) {
      if (o.deletedAt) continue
      if (o.createdAt < CX_CALL_SLA_STARTS_AT || o.createdAt > cutoff) continue
      await raiseAccountabilityFlag(
        ctx, o, "Confirmation call overdue",
        `Placed ${Math.floor((now - o.createdAt) / DAY)} day(s) ago — still Pending, no confirmation call resolved yet (SLA: ${CONFIRMATION_CALL_SLA_DAYS} days).`,
        "BlackBole Ops (automatic)",
        { ruleKey: "cx.overdue_confirmation_call" },
      )
    }
  },
})

/** Delivered orders with no post-delivery feedback call (`csat`) logged inside the SLA window. Bounded by
 *  createdAt (not statusChangedAt), on purpose: a delivered_due order that later moves to delivered_paid days
 *  later, when the due cash is actually collected, would otherwise drop out of a statusChangedAt-bounded scan
 *  the moment its due got paid — exactly when it's most overdue on the feedback call. */
export const overdueFeedbackCallCheck = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now()
    const cutoff = now - FEEDBACK_CALL_SLA_DAYS * DAY
    const since = now - CX_SLA_LOOKBACK_DAYS * DAY
    for (const status of ["delivered_due", "delivered_paid"] as const) {
      const rows = await ctx.db.query("orders").withIndex("by_status", (q) => q.eq("status", status).gte("createdAt", since)).collect()
      for (const o of rows) {
        if (o.deletedAt || o.csat || !o.deliveredAt) continue
        if (o.deliveredAt < CX_CALL_SLA_STARTS_AT || o.deliveredAt > cutoff) continue
        await raiseAccountabilityFlag(
          ctx, o, "Feedback call overdue",
          `Delivered ${Math.floor((now - o.deliveredAt) / DAY)} day(s) ago — no post-delivery feedback call logged yet (SLA: ${FEEDBACK_CALL_SLA_DAYS} days).`,
          "BlackBole Ops (automatic)",
          { ruleKey: "cx.overdue_feedback_call" },
        )
      }
    }
  },
})

/** Returned/damaged orders with no return feedback call (`returnCsat`) logged inside the SLA window. Same
 *  createdAt-bounded shape as the feedback-call check above, for the same reason. */
export const overdueReturnCallCheck = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now()
    const cutoff = now - RETURN_CALL_SLA_DAYS * DAY
    const since = now - CX_SLA_LOOKBACK_DAYS * DAY
    for (const status of ["pending_returned", "returned", "damaged"] as const) {
      const rows = await ctx.db.query("orders").withIndex("by_status", (q) => q.eq("status", status).gte("createdAt", since)).collect()
      for (const o of rows) {
        if (o.deletedAt || o.returnCsat) continue
        if (o.statusChangedAt === undefined || o.statusChangedAt < CX_CALL_SLA_STARTS_AT || o.statusChangedAt > cutoff) continue
        await raiseAccountabilityFlag(
          ctx, o, "Return call overdue",
          `In a returned/damaged status ${Math.floor((now - o.statusChangedAt) / DAY)} day(s) — no return feedback call logged yet (SLA: ${RETURN_CALL_SLA_DAYS} days).`,
          "BlackBole Ops (automatic)",
          { ruleKey: "cx.overdue_return_call" },
        )
      }
    }
  },
})

const HOLD_SLA_DAYS = 7 // an order shouldn't just sit On Hold indefinitely — someone owes it a resolution within this long
const DISPATCH_SLA_DAYS = 1 // a confirmed order should be handed to the courier within this long, even if it isn't dispatched the SAME calendar day (fulfillment.late_dispatch already docks that narrower miss the moment it IS dispatched)

/** Orders stuck On Hold past the SLA — nobody went back to resolve whatever it was waiting on (a promised
 *  advance, a customer callback, stock). Bounded by statusChangedAt via by_status_changed: the moment an order
 *  leaves "on_hold" for any other status, it naturally drops out of this scan, which is exactly right — it's
 *  no longer sitting in hold. */
export const overdueHoldCheck = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now()
    const cutoff = now - HOLD_SLA_DAYS * DAY
    const since = now - CX_SLA_LOOKBACK_DAYS * DAY
    const rows = await ctx.db.query("orders").withIndex("by_status_changed", (q) => q.eq("status", "on_hold").gte("statusChangedAt", since)).collect()
    for (const o of rows) {
      if (o.deletedAt) continue
      if (o.statusChangedAt < CX_CALL_SLA_STARTS_AT || o.statusChangedAt > cutoff) continue
      await raiseAccountabilityFlag(
        ctx, o, "Hold overdue",
        `On Hold ${Math.floor((now - o.statusChangedAt) / DAY)} day(s) — still unresolved (SLA: ${HOLD_SLA_DAYS} days).`,
        "BlackBole Ops (automatic)",
        { ruleKey: "cx.overdue_hold" },
      )
    }
  },
})

/** Orders confirmed (approved) but never actually handed to a courier past the SLA. Bounded by approvedAt
 *  (via by_approved), not statusChangedAt — an order can pass through processing/pre-order/ready-to-ship on
 *  its way to in_transit, each move resetting statusChangedAt, but the clock that matters here started the
 *  moment it was confirmed, not whichever intermediate status it's currently sitting in. */
export const overdueDispatchCheck = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now()
    const cutoff = now - DISPATCH_SLA_DAYS * DAY
    const since = now - CX_SLA_LOOKBACK_DAYS * DAY
    const rows = await ctx.db.query("orders").withIndex("by_approved", (q) => q.gte("approvedAt", since)).collect()
    const preDispatch = new Set<OrderStatus>(["approved", "processing", "pre_order", "pre_order_bd", "ready_to_ship"])
    for (const o of rows) {
      if (o.deletedAt || o.shippedAt || !o.approvedAt) continue
      if (!preDispatch.has(o.status as OrderStatus)) continue
      if (o.approvedAt < CX_CALL_SLA_STARTS_AT || o.approvedAt > cutoff) continue
      await raiseAccountabilityFlag(
        ctx, o, "Dispatch overdue",
        `Confirmed ${Math.floor((now - o.approvedAt) / DAY)} day(s) ago — still not handed to a courier (SLA: ${DISPATCH_SLA_DAYS} day).`,
        "BlackBole Ops (automatic)",
        { ruleKey: "fulfillment.overdue_dispatch" },
      )
    }
  },
})

/** A parcel that's out for delivery but Pathao has reported a failed attempt ("Delivery_Failed" and its
 *  variants — same normalization pathao.ts's targetFor uses, since this reads the exact same courierStatus
 *  field that sync already writes). Doesn't move the order's own status (Pathao keeps retrying), so there's no
 *  status transition to hook this off of — it has to be its own scan. Gated by updatedAt, same "count from
 *  today forward" spirit as the other checks, since updatedAt moves every time the sync touches the order. */
export const deliveryFailedCheck = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now()
    const since = now - CX_SLA_LOOKBACK_DAYS * DAY
    const rows = await ctx.db.query("orders").withIndex("by_status", (q) => q.eq("status", "in_transit").gte("createdAt", since)).collect()
    for (const o of rows) {
      if (o.deletedAt || !o.courierStatus) continue
      if (o.updatedAt < CX_CALL_SLA_STARTS_AT) continue
      const s = o.courierStatus.toLowerCase().replace(/[\s.-]+/g, "_")
      if (!s.includes("delivery_failed")) continue
      await raiseAccountabilityFlag(
        ctx, o, "Delivery attempt failed",
        `Pathao reported a failed delivery attempt (status: "${o.courierStatus}") — parcel still out, not yet resolved.`,
        "BlackBole Ops (automatic)",
        { ruleKey: "fulfillment.delivery_failed" },
      )
    }
  },
})

// Fulfillment's own weekly "clean" award — same idea as ops.clean_week, but scoped to just the department's own
// named misses (not every generic flag in the business), so the Fulfillment lead has something to earn by
// keeping those specific numbers at zero for a week, not just more ways to lose points.
const FULFILLMENT_NEGATIVE_KEYS = [
  "fulfillment.late_dispatch", "fulfillment.overdue_dispatch", "fulfillment.wrong_item_sent",
  "fulfillment.wrong_size_sent", "fulfillment.damaged_sent", "fulfillment.late_delivery_return", "fulfillment.delivery_failed",
]

export const weeklyFulfillmentCleanCheck = internalMutation({
  args: {},
  handler: async (ctx) => {
    const owners = await ownersConf(ctx)
    const lead = owners.byTeam["Fulfillment"]
    if (!lead?.name) return
    const since = Date.now() - 7 * DAY
    const recent = await ctx.db.query("kpiEvents").withIndex("by_staff", (q) => q.eq("staffName", lead.name).gte("at", since)).collect()
    if (recent.some((e) => e.ruleKey === "fulfillment.clean_week")) return // already awarded this week
    if (recent.some((e) => FULFILLMENT_NEGATIVE_KEYS.includes(e.ruleKey))) return
    await awardPoints(ctx, {
      staffName: lead.name, ruleKey: "fulfillment.clean_week",
      label: "A full week with none of Fulfillment's own named misses (late dispatch, wrong item/size, damaged, late-delivery return, failed attempt)",
    })
  },
})

/** Every order still sitting in one status whose status hasn't changed since before the cutoff — bounded by
 *  the (status, statusChangedAt) index, so this only ever scans orders currently in that one status, never the
 *  whole orders table. */
export const staleInStatus = internalQuery({
  args: { status: v.string(), cutoff: v.number() },
  handler: async (ctx, { status, cutoff }) => {
    const rows = await ctx.db.query("orders").withIndex("by_status_changed", (q) => q.eq("status", status as OrderStatus).lt("statusChangedAt", cutoff)).collect()
    return rows.map((o) => ({ invoice: invoiceLabel(o), days: Math.floor((Date.now() - (o.statusChangedAt ?? Date.now())) / DAY) }))
  },
})

/** Every flag tied to an order, raised within the window, grouped by product name — counts how often each
 *  product shows up and which department its flags mostly went to. Bounded to three index-scoped scans (one
 *  per status) over the window, never a full table scan. */
export const productHotspots = internalQuery({
  args: { cutoff: v.number() },
  handler: async (ctx, { cutoff }) => {
    const statuses = ["open", "resolved", "archived"]
    const rows: Doc<"opsFlags">[] = []
    for (const status of statuses) {
      rows.push(...(await ctx.db.query("opsFlags").withIndex("by_status", (q) => q.eq("status", status).gte("raisedAt", cutoff)).collect()))
    }
    const byProduct = new Map<string, { teams: Record<string, number>; count: number }>()
    for (const r of rows) {
      if (!r.orderId || !r.productNames?.length) continue
      for (const name of r.productNames) {
        const g = byProduct.get(name) ?? { teams: {}, count: 0 }
        g.count += 1
        g.teams[r.team] = (g.teams[r.team] ?? 0) + 1
        byProduct.set(name, g)
      }
    }
    return [...byProduct.entries()].map(([product, g]) => ({
      product, count: g.count,
      team: Object.entries(g.teams).sort((a, b) => b[1] - a[1])[0][0],
    }))
  },
})
