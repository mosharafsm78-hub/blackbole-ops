// Cloudflare Worker: a nearby relay for the Convex database.
// Browsers in Bangladesh connect to Cloudflare (Dhaka/Singapore) quickly; Cloudflare forwards to Convex (US East),
// including the live WebSocket connection.
const ORIGIN = "basic-crane-965.convex.cloud"

export default {
  async fetch(request) {
    const url = new URL(request.url)
    url.hostname = ORIGIN
    url.protocol = "https:"
    url.port = ""
    return fetch(new Request(url, request))
  },
}
