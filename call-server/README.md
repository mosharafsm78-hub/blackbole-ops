# BlackBole call server

Places the automatic order-confirmation calls for BlackBole Ops (and, later, for other stores).

- **Asterisk** talks to the licensed SIP line (IPTSP) and plays the Bangla message.
- **app/** (Node) receives "call this customer" from Ops, drives the call through Asterisk ARI,
  reads the key press (1 confirm · 2 cancel · 3 talk to us) and reports it back to Ops.

```
Ops ──POST /calls──▶ app ──ARI originate──▶ Asterisk ──SIP──▶ licensed line ──▶ customer
Ops ◀──POST /auto-call/result── app ◀── key press / hang-up ──┘
```

## Run (on the VPS)
1. Copy `.env.example` to `.env` and fill in the SIP line details from the provider, the shared key
   (same as Ops → Settings → Auto calls → Call server key) and the customer care number for "press 3".
2. Put the Bangla prompts in `sounds/` (8 kHz mono WAV): `greeting.wav`, `menu.wav`, `thanks_confirm.wav`,
   `thanks_cancel.wav`, `connecting.wav`, `no_input.wav`, and `digit_0.wav` … `digit_9.wav`, `taka.wav`.
3. `docker compose up -d`
4. Point a domain (e.g. calls.blackbole.com) with HTTPS at port 8080, and put that address in Ops.

## API
`POST /calls` — `Authorization: Bearer <key>` — `{ ref, to: "8801XXXXXXXXX", vars: { invoice, amount, product, customer }, callbackUrl }`
→ reports to `callbackUrl`: `{ ref, callRef, result: answered|no_answer|busy|failed, digit?, durationSec }`
