// Cloudflare Worker "blackbole-db" (https://blackbole-db.mosharafsm78.workers.dev) — standby relay for the Convex database.
// Not used by the app yet (RELAY_URL in src/components/convex-client-provider.tsx is empty).
// Placement: Service = basic-crane-965.convex.cloud:443 (runs next to the database).
// /__ping measures how long opening the live connection to Convex takes from Cloudflare.
const ORIGIN = "basic-crane-965.convex.cloud";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/__ping") {
      const out = [];
      for (let i = 0; i < 3; i++) {
        const t = Date.now();
        const r = await fetch("https://" + ORIGIN + "/api/1.31.0/sync", { headers: { Upgrade: "websocket" } });
        if (r.webSocket) { r.webSocket.accept(); r.webSocket.close(); }
        out.push([r.status, Date.now() - t]);
      }
      return Response.json({ colo: request.cf && request.cf.colo, out });
    }
    url.hostname = ORIGIN;
    url.protocol = "https:";
    url.port = "";
    return fetch(new Request(url, request));
  },
};
