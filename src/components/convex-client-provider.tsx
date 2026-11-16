import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { ConvexReactClient } from "convex/react";
import { useEffect, useState } from "react";

const CONVEX_URL = (import.meta as any).env.VITE_CONVEX_URL as string
// Nearby Cloudflare relay for the live connection (much faster to open from Bangladesh). Empty = connect directly.
const RELAY_URL = ""

// Ops runs on BlackBole's own server (VPS): since 16 Nov 2026 night the Tencent Singapore server (2 CPUs).
// The old cloud address and the old InterServer address only forward outside calls (webhooks, website) here.
const VPS_URL = "https://ops-api.43-156-155-69.sslip.io"
export const SERVER = "vps" as const

// Keep everyone signed in across server moves: the saved sign-in is stored under the server address,
// so copy the long-lived refresh token from the previous addresses (a fresh login token is fetched with it).
const ns = (u: string) => u.replace(/[^a-zA-Z0-9]/g, "")
try {
  const to = "__convexAuthRefreshToken_" + ns(VPS_URL)
  if (typeof localStorage !== "undefined" && !localStorage.getItem(to)) {
    for (const prev of ["https://ops-api.216-219-95-184.sslip.io", "https://basic-crane-965.convex.cloud"]) {
      const v = localStorage.getItem("__convexAuthRefreshToken_" + ns(prev))
      if (v) { localStorage.setItem(to, v); break }
    }
  }
} catch { /* storage blocked: the person just signs in again */ }
const convex = new ConvexReactClient(VPS_URL, { skipConvexDeploymentUrlCheck: true })
void RELAY_URL; void CONVEX_URL

export default function AppConvexProvider({
  children,
}: {
  children: React.ReactNode
}) {
  // Shown only after the page has started in the browser (the server-rendered page can't know the choice).
  const [showBadge] = useState(false) // no test badge any more: everyone is on the VPS
  useEffect(() => {}, [])
  return (
    <ConvexAuthProvider client={convex}>
      {showBadge && (
        <div className="fixed bottom-2 left-2 z-[100] rounded bg-violet-600 px-2 py-1 text-[11px] font-medium text-white shadow" data-testid="server-badge">
          Own server (VPS) · <a href="?server=cloud" className="underline">back to cloud</a>
        </div>
      )}
      {children}
    </ConvexAuthProvider>
  )
}
