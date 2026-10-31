// HTML for the "finish your order" email sent to abandoned carts. Pure functions, so it can be unit tested.
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
/** The live store (blackbole.com is down; blackbole.top is up). One place to change when the main domain is back. */
export const SITE = "https://blackbole.top"
const tk = (n: number) => `৳${Math.round(n).toLocaleString("en-US")}`

/** Gift-box leads are saved with the name "Gift box · won Tk 500 (BB-X9U8UN)": pull the gift out of it. */
export function parseGift(name: string): { amount: number; code: string } | null {
  const m = /won\s+Tk\s*([\d,]+)\s*\(([A-Za-z0-9-]+)\)/i.exec(name)
  return m ? { amount: Number(m[1].replace(/,/g, "")), code: PREORDER_CODE } : null
}

type Item = { name: string; attrs?: string; imageUrl?: string; price: number; qty: number }

/** One permanent Shopify code for every pre-order gift (Tk 500 off pre-order items, once per customer). */
export const PREORDER_CODE = "PREORDER500"
export const WELCOME = { amount: 50, code: "WELCOME50" }
export type EmailKind = "preorder" | "regular" | "welcome"
export type Pick = { name: string; imageUrl?: string; price: number; url: string }

/** step 1 = the first email; 2+ = follow-ups (every 2 days until they order). picks = other products to show. */
/** Up to 8 products in two rows of 4, each a photo with its name (and price) under it. */
export function picksBlock(picks: Pick[], title: string): string {
  if (!picks.length) return ""
  return `<tr><td style="padding:22px 28px 0"><div style="font-size:12px;letter-spacing:3px;font-weight:bold;color:#7a746b;margin-bottom:12px">${esc(title)}</div>
<table width="100%" cellpadding="0" cellspacing="0">${[0, 4].map((o) => picks.slice(o, o + 4)).filter((r) => r.length).map((row) => `<tr>${row.map((p) => `<td width="25%" valign="top" style="padding:0 4px 14px"><a href="${esc(p.url)}" style="text-decoration:none;color:#1c1915">${p.imageUrl && /^https?:\/\//.test(p.imageUrl) ? `<img src="${esc(p.imageUrl)}" width="112" alt="" style="display:block;width:100%;height:auto;border-radius:10px;background:#f4f1ec">` : `<div style="height:110px;border-radius:10px;background:#f4f1ec"></div>`}<div style="font-size:12px;line-height:1.3;margin-top:6px;font-weight:bold">${esc(p.name.length > 38 ? p.name.slice(0, 36) + "…" : p.name)}</div>${p.price > 0 ? `<div style="font-size:12px;color:#7a746b;margin-top:2px">${tk(p.price)}</div>` : ""}</a></td>`).join("")}${row.length < 4 ? `<td colspan="${4 - row.length}"></td>` : ""}</tr>`).join("")}</table></td></tr>`
}

/** Win-back ("we miss you") email: coupon box, button, 8 products. */
export function winbackEmailContent(a: { name: string; code: string; amount: number; minOrder: number; hotline?: string; picks?: Pick[] }) {
  const hello = a.name && a.name.trim() && a.name.trim() !== "-" ? a.name.trim() : "there"
  const subject = "We miss you at BlackBole 💙"
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#f4f1ec;font-family:Arial,Helvetica,sans-serif;color:#1c1915">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">Tk ${a.amount} off your next order. Your coupon is inside.</div>
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1ec;padding:24px 10px"><tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:18px;overflow:hidden">
<tr><td style="background:#1c1915;color:#ffffff;padding:20px 28px;font-size:22px;letter-spacing:6px;font-weight:bold">BLACKBOLE</td></tr>
<tr><td style="padding:30px 28px 14px"><div style="font-size:26px;line-height:1.25;font-weight:bold">Hi ${esc(hello)}, we miss you 💙</div>
<div style="font-size:15px;line-height:1.6;color:#4a453d;margin-top:10px">You bought a pair from us, and it has been a while since we last saw you. We hope they are treating your feet well. Since then we have added new styles, and we would love to have you back. Here is a little something to welcome you.</div></td></tr>
<tr><td style="padding:0 28px 8px"><table width="100%" cellpadding="0" cellspacing="0" style="background:#fff7e0;border:2px dashed #d9a400;border-radius:14px"><tr><td align="center" style="padding:20px 16px">
<div style="font-size:12px;letter-spacing:3px;color:#8a6a00;font-weight:bold">COMEBACK COUPON</div>
<div style="font-size:34px;font-weight:bold;color:#1c1915;margin:6px 0">Tk ${a.amount} OFF</div>
<div style="font-size:13px;color:#5a4a00">Your coupon code</div>
<div style="display:inline-block;margin-top:6px;padding:8px 18px;background:#1c1915;color:#ffd24a;font-size:18px;letter-spacing:3px;font-weight:bold;border-radius:8px">${esc(a.code)}</div>
<div style="font-size:12px;color:#5a4a00;margin-top:10px">Use this code at checkout on orders of ${tk(a.minOrder)} or more. One use per customer.</div>
</td></tr></table></td></tr>
<tr><td align="center" style="padding:22px 28px 10px"><a href="${SITE}" style="display:block;background:#1c1915;color:#ffffff;text-decoration:none;font-size:17px;font-weight:bold;padding:17px 20px;border-radius:12px">See what's new →</a></td></tr>
${picksBlock(a.picks ?? [], "NEW COLLECTION")}
<tr><td style="padding:18px 28px 26px;font-size:13px;line-height:1.6;color:#4a453d">Need help choosing a size? Just reply to this email${a.hotline ? ` or call us on <b>${esc(a.hotline)}</b>` : ""}. We're happy to help.</td></tr>
<tr><td style="padding:16px 28px;border-top:1px solid #eee;font-size:11px;line-height:1.5;color:#9a948a">You are receiving this because you have shopped with BlackBole. BlackBole</td></tr>
</table></td></tr></table></body></html>`
  const text = `Hi ${hello}, we miss you at BlackBole! Use code ${a.code} for Tk ${a.amount} off your next order (orders of ${tk(a.minOrder)}+). Shop: ${SITE}`
  return { subject, html, text }
}

export function abandonedEmailContent(a: { customerName: string; items: Item[]; subtotal: number; url?: string; hotline?: string; step?: number; picks?: Pick[]; kind?: EmailKind }) {
  const step = a.step ?? 1
  const gift0 = parseGift(a.customerName)
  const kind: EmailKind = a.kind ?? (gift0 ? "preorder" : "preorder")
  const welcome = kind === "welcome"
  const regular = kind === "regular"
  const gift = welcome ? WELCOME : gift0
  const first = gift ? "" : (a.customerName || "").trim().split(/\s+/)[0]
  const hello = first && first.toLowerCase() !== "customer" ? first : "there"
  const link = a.url && /^https?:\/\//.test(a.url) ? a.url : SITE
  const subject = welcome
    ? (step > 1 ? `🎁 Still there: your Tk ${WELCOME.amount} welcome offer` : `🎁 Your Tk ${WELCOME.amount} welcome offer is waiting`)
    : regular
      ? (step > 1 ? `${hello === "there" ? "Still" : hello + ", still"} thinking about your cart?` : `${hello === "there" ? "You" : hello + ", you"} left something in your cart`)
      : step > 1 ? (gift ? `🎁 Still thinking? Your Tk ${gift.amount} gift is saved` : `${hello === "there" ? "Still" : hello + ", still"} thinking about your pair?`) : gift ? `🎁 Your Tk ${gift.amount} gift is still waiting for you` : `${hello === "there" ? "You" : hello + ", you"} left something behind at BlackBole`
  const pre = welcome ? `Your Tk ${WELCOME.amount} off is waiting. Pick your pair and it is added to your order.` : regular ? "Your cart is saved. Finish your order in one tap." : gift ? `Your Tk ${gift.amount} gift is saved. Finish your order before someone else takes your size.` : "Your pair is saved. Finish your order in one tap."
  const rows = a.items.slice(0, 6).map((i) => `
<tr><td style="padding:14px 0;border-bottom:1px solid #eee">
<table width="100%" cellpadding="0" cellspacing="0"><tr>
<td width="84" valign="top">${i.imageUrl && /^https?:\/\//.test(i.imageUrl) ? `<img src="${esc(i.imageUrl)}" width="76" height="76" alt="" style="display:block;border-radius:10px;object-fit:cover;background:#f4f1ec">` : `<div style="width:76px;height:76px;border-radius:10px;background:#f4f1ec"></div>`}</td>
<td valign="top" style="padding-left:6px"><div style="font-size:15px;font-weight:bold;color:#1c1915;line-height:1.35">${esc(i.name)}</div>
${i.attrs ? `<div style="font-size:13px;color:#7a746b;margin-top:3px">Size / option: ${esc(i.attrs)}</div>` : ""}
<div style="font-size:13px;color:#7a746b;margin-top:3px">Qty ${i.qty}</div></td>
<td valign="top" align="right" style="font-size:15px;font-weight:bold;color:#1c1915;white-space:nowrap">${tk(i.price * i.qty)}</td>
</tr></table></td></tr>`).join("")
  const giftBlock = gift ? `
<tr><td style="padding:0 28px 8px"><table width="100%" cellpadding="0" cellspacing="0" style="background:#fff7e0;border:2px dashed #d9a400;border-radius:14px"><tr><td align="center" style="padding:20px 16px">
<div style="font-size:12px;letter-spacing:3px;color:#8a6a00;font-weight:bold">${welcome ? "WELCOME COUPON" : "PRE-ORDER COUPON"}</div>
<div style="font-size:34px;font-weight:bold;color:#1c1915;margin:6px 0">Tk ${gift.amount} OFF</div>
<div style="font-size:13px;color:#5a4a00">Your coupon code</div>
<div style="display:inline-block;margin-top:6px;padding:8px 18px;background:#1c1915;color:#ffd24a;font-size:18px;letter-spacing:3px;font-weight:bold;border-radius:8px">${esc(gift.code)}</div>
<div style="font-size:12px;color:#5a4a00;margin-top:10px">${welcome ? `Use this code at checkout to get Tk ${gift.amount} off.` : `Use this code at checkout on your pre-order to get Tk ${gift.amount} off.`}</div>
</td></tr></table></td></tr>` : ""
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#f4f1ec;font-family:Arial,Helvetica,sans-serif;color:#1c1915">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(pre)}</div>
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1ec;padding:24px 10px"><tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:18px;overflow:hidden">
<tr><td style="background:#1c1915;color:#ffffff;padding:20px 28px;font-size:22px;letter-spacing:6px;font-weight:bold">BLACKBOLE</td></tr>
<tr><td style="padding:30px 28px 14px">
<div style="font-size:26px;line-height:1.25;font-weight:bold">${welcome ? `Your Tk ${WELCOME.amount} off is waiting 🎁` : regular ? (step > 1 ? `Hi ${esc(hello)}, your cart is still saved` : `Hi ${esc(hello)}, your cart is waiting`) : step > 1 ? (gift ? "Your gift is still saved 🎁" : `Hi ${esc(hello)}, your pair is still saved`) : gift ? "Your gift is still waiting 🎁" : `Hi ${esc(hello)}, your pair is waiting`}</div>
<div style="font-size:15px;line-height:1.6;color:#4a453d;margin-top:10px">${welcome ? `Thanks for joining BlackBole. Your <b>Tk ${WELCOME.amount} off</b> is ready. It is added to your order automatically when you shop.` : regular ? "You picked something great but didn't finish your order. We saved your cart. It takes one tap to complete." : gift ? `You unlocked <b>Tk ${gift.amount} off</b> on BlackBole, but your order isn't finished yet. Your pair is saved below. It takes one tap to complete it.` : "You picked something great but didn't finish your order. We saved it for you. It takes one tap to complete."}</div>
</td></tr>
${giftBlock}
${welcome ? "" : `<tr><td style="padding:8px 28px 0"><table width="100%" cellpadding="0" cellspacing="0">${rows}
<tr><td style="padding:16px 0 4px"><table width="100%" cellpadding="0" cellspacing="0"><tr><td style="font-size:14px;color:#7a746b">Cart total (delivery added at checkout)</td><td align="right" style="font-size:18px;font-weight:bold">${tk(a.subtotal)}</td></tr></table></td></tr>
</table></td></tr>`}
<tr><td align="center" style="padding:22px 28px 10px"><a href="${esc(link)}" style="display:block;background:#1c1915;color:#ffffff;text-decoration:none;font-size:17px;font-weight:bold;padding:17px 20px;border-radius:12px">${welcome ? "Start shopping →" : regular ? "Back to my cart →" : "Go to my pre-order →"}</a>
<div style="font-size:12px;color:#7a746b;margin-top:10px">${regular ? "Cash on delivery available. It takes under a minute." : welcome ? "Your offer is saved for you." : "Your pair is saved. It takes under a minute."}</div></td></tr>

${picksBlock(a.picks ?? [], regular || welcome ? "MORE FROM BLACKBOLE" : "MORE PRE-ORDERS FROM BLACKBOLE")}
<tr><td style="padding:18px 28px 26px;font-size:13px;line-height:1.6;color:#4a453d">Questions about size or delivery? Just reply to this email${a.hotline ? ` or call us on <b>${esc(a.hotline)}</b>` : ""}. We're happy to help.</td></tr>
<tr><td style="padding:16px 28px;border-top:1px solid #eee;font-size:11px;line-height:1.5;color:#9a948a">You are receiving this because you started an order with BlackBole and shared your email.</td></tr>
</table></td></tr></table></body></html>`
  const text = `${gift ? `Your Tk ${gift.amount} gift is still waiting (code ${gift.code}).` : `Hi ${hello}, you left something in your cart.`}\n\n${a.items.map((i) => `- ${i.name}${i.attrs ? ` (${i.attrs})` : ""} x${i.qty} — ${tk(i.price * i.qty)}`).join("\n")}\n\nComplete your order: ${link}\n\nBlackBole`
  return { subject, html, text }
}
