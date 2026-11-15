import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { ConvexReactClient } from "convex/react";

const CONVEX_URL = (import.meta as any).env.VITE_CONVEX_URL as string
if (!CONVEX_URL) {
  console.error('missing envar CONVEX_URL')
}
// Nearby Cloudflare relay for the live connection (much faster to open from Bangladesh). Empty = connect directly.
const RELAY_URL = ""

// Moving off Convex cloud: the self-hosted copy on BlackBole's own VPS. Open Ops with ?server=vps to try it in
// this browser only (remembered), ?server=cloud to go back. Everyone else keeps using the default server.
const VPS_URL = "https://ops-api.216-219-95-184.sslip.io"
function chosenServer(): "vps" | "cloud" {
  if (typeof window === "undefined") return "cloud"
  try {
    const q = new URLSearchParams(window.location.search).get("server")
    if (q === "vps" || q === "cloud") localStorage.setItem("bb-server", q)
    return localStorage.getItem("bb-server") === "vps" ? "vps" : "cloud"
  } catch { return "cloud" }
}
export const SERVER = chosenServer()
const convex = SERVER === "vps"
  ? new ConvexReactClient(VPS_URL, { skipConvexDeploymentUrlCheck: true })
  : new ConvexReactClient(RELAY_URL || CONVEX_URL, { skipConvexDeploymentUrlCheck: !!RELAY_URL })

export default function AppConvexProvider({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <ConvexAuthProvider client={convex}>
      {SERVER === "vps" && (
        <div className="fixed bottom-2 left-2 z-[100] rounded bg-violet-600 px-2 py-1 text-[11px] font-medium text-white shadow" data-testid="server-badge">
          Own server (VPS) · <a href="?server=cloud" className="underline">back to cloud</a>
        </div>
      )}
      {children}
    </ConvexAuthProvider>
  )
}
