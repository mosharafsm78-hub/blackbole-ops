// BlackBole call server — drives Asterisk (ARI) to make order-confirmation calls for Ops.
// Ops → POST /calls { ref, to, vars, callbackUrl }  (Bearer API_KEY)
// we → POST callbackUrl { ref, callRef, result, digit, durationSec } (Bearer API_KEY)
import http from "node:http"
import WebSocket from "ws"

const ARI = "http://127.0.0.1:8088/ari"
const AUTH = "Basic " + Buffer.from(`bb:${process.env.ARI_PASSWORD}`).toString("base64")
const KEY = process.env.API_KEY ?? ""
const MAX = Number(process.env.MAX_CHANNELS || 4)
const CARE = process.env.CARE_NUMBER ?? ""
const WAIT_DIGIT_MS = 8000

const queue = []            // calls waiting for a free line
const calls = new Map()     // channelId → call state

const ari = (path, method = "POST", body) => fetch(`${ARI}${path}`, {
  method, headers: { Authorization: AUTH, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => { if (!r.ok) throw new Error(`ARI ${method} ${path} → ${r.status} ${await r.text()}`); return r.status === 204 ? null : r.json() })

async function report(c, result, digit) {
  if (c.reported) return
  c.reported = true
  const body = { ref: c.ref, callRef: c.channelId, result, digit, durationSec: c.answeredAt ? Math.round((Date.now() - c.answeredAt) / 1000) : 0 }
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(c.callbackUrl, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` }, body: JSON.stringify(body) })
      if (r.ok) return
    } catch {}
    await new Promise((res) => setTimeout(res, 2000 * (i + 1)))
  }
  console.error("could not report", body)
}

// ---------- prompts ----------
const sound = (name) => `sound:bb/${name}`
const amountSounds = (amount) => [...String(Math.round(Number(amount) || 0))].map((d) => sound(`digit_${d}`)).concat(sound("taka"))
async function play(channelId, media) {
  const pb = await ari(`/channels/${channelId}/play`, "POST", { media })
  return new Promise((resolve) => { const c = calls.get(channelId); if (c) c.onPlaybackDone = { id: pb.id, resolve }; else resolve() })
}

async function runMenu(c) {
  // "আসসালামু আলাইকুম, BlackBole থেকে বলছি। আপনার অর্ডারের মূল্য …" + amount + menu, asked twice
  for (let round = 0; round < 2 && !c.digit; round++) {
    await play(c.channelId, [sound("greeting"), ...amountSounds(c.vars.amount), sound("menu")])
    if (c.digit) break
    await new Promise((res) => { c.wakeOnDigit = res; setTimeout(res, WAIT_DIGIT_MS) })
    if (!c.digit && round === 0) await play(c.channelId, [sound("no_input")])
  }
  const d = c.digit
  if (d === "1") { await play(c.channelId, [sound("thanks_confirm")]); await report(c, "answered", "1") }
  else if (d === "2") { await play(c.channelId, [sound("thanks_cancel")]); await report(c, "answered", "2") }
  else if (d === "3") {
    await report(c, "answered", "3")
    await play(c.channelId, [sound("connecting")])
    if (CARE) { await ari(`/channels/${c.channelId}/redirect?endpoint=${encodeURIComponent(`PJSIP/${CARE}@line`)}`).catch(() => {}); return }
  } else await report(c, "answered", undefined) // answered, pressed nothing
  await ari(`/channels/${c.channelId}`, "DELETE").catch(() => {})
}

// ---------- dialing ----------
function pump() {
  while (calls.size < MAX && queue.length) {
    const job = queue.shift()
    const channelId = `bb-${job.ref}-${Date.now()}`
    const c = { ...job, channelId, digit: null, reported: false }
    calls.set(channelId, c)
    ari(`/channels?endpoint=${encodeURIComponent(`PJSIP/${job.to.replace(/^88/, "")}@line`)}&app=autocall&channelId=${channelId}&timeout=35&callerId=${encodeURIComponent(process.env.CALLER_ID ?? "")}`)
      .catch(async (e) => { console.error(e.message); calls.delete(channelId); await report(c, "failed"); pump() })
  }
}

function connectEvents() {
  const ws = new WebSocket(`ws://127.0.0.1:8088/ari/events?app=autocall&api_key=bb:${process.env.ARI_PASSWORD}`)
  ws.on("message", async (raw) => {
    const e = JSON.parse(String(raw))
    const c = e.channel ? calls.get(e.channel.id) : null
    if (e.type === "StasisStart" && c) { c.answeredAt = Date.now(); runMenu(c).catch((err) => console.error(err)) }
    if (e.type === "ChannelDtmfReceived" && c && !c.digit && ["1", "2", "3"].includes(e.digit)) {
      c.digit = e.digit
      ari(`/playbacks/${c.onPlaybackDone?.id}`, "DELETE").catch(() => {})
      c.wakeOnDigit?.()
    }
    if (e.type === "PlaybackFinished") for (const x of calls.values()) if (x.onPlaybackDone?.id === e.playback.id) { x.onPlaybackDone.resolve(); x.onPlaybackDone = null }
    if (e.type === "ChannelDestroyed" && c) {
      calls.delete(e.channel.id)
      if (!c.reported) {
        const cause = e.cause // 17 busy, 18/19 no answer, 16 normal clearing
        await report(c, c.answeredAt ? "answered" : cause === 17 ? "busy" : [18, 19, 16, 21].includes(cause) ? "no_answer" : "failed")
      }
      pump()
    }
  })
  ws.on("close", () => setTimeout(connectEvents, 3000))
  ws.on("error", () => {})
}

// ---------- HTTP API for Ops ----------
http.createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/calls") { res.writeHead(404).end(); return }
  if (req.headers.authorization !== `Bearer ${KEY}` || !KEY) { res.writeHead(401).end(); return }
  let body = ""
  req.on("data", (d) => { body += d; if (body.length > 10000) req.destroy() })
  req.on("end", () => {
    try {
      const j = JSON.parse(body)
      if (!j.ref || !/^8801[3-9]\d{8}$/.test(j.to) || !j.callbackUrl) throw new Error("bad request")
      queue.push({ ref: String(j.ref), to: j.to, vars: j.vars ?? {}, callbackUrl: String(j.callbackUrl) })
      pump()
      res.writeHead(202, { "Content-Type": "application/json" }).end('{"ok":true}')
    } catch { res.writeHead(400).end('{"ok":false}') }
  })
}).listen(8080, () => console.log("call server on :8080"))

connectEvents()
