import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { ConvexReactClient } from "convex/react";

const CONVEX_URL = (import.meta as any).env.VITE_CONVEX_URL as string
if (!CONVEX_URL) {
  console.error('missing envar CONVEX_URL')
}
// Nearby Cloudflare relay for the live connection (much faster to open from Bangladesh). Empty = connect directly.
const RELAY_URL = ""
const convex = new ConvexReactClient(RELAY_URL || CONVEX_URL, { skipConvexDeploymentUrlCheck: !!RELAY_URL })

export default function AppConvexProvider({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <ConvexAuthProvider client={convex}>
      {children}
    </ConvexAuthProvider>
  )
}
