import { useState } from "react"
import { useAuthActions } from "@convex-dev/auth/react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

/** Email + password sign-in. New team members create their password the first time. */
export function SignInForm({ brand }: { brand: React.ReactNode }) {
  const { signIn } = useAuthActions()
  const [flow, setFlow] = useState<"signIn" | "signUp">("signIn")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-sm rounded-xl border bg-card p-6 shadow-sm">
        {brand}
        <h1 className="mt-6 text-lg font-semibold">{flow === "signIn" ? "Sign in" : "Create your password"}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {flow === "signIn"
            ? "Use the email your admin added to the team."
            : "First time here? Use the email your admin added, and choose a password (8+ characters)."}
        </p>
        <form
          className="mt-5 space-y-3"
          onSubmit={async (e) => {
            e.preventDefault()
            setBusy(true)
            setError(null)
            const fd = new FormData(e.currentTarget)
            fd.set("flow", flow)
            try {
              await signIn("password", fd)
            } catch {
              setError(
                flow === "signIn"
                  ? "Email or password is wrong. First time? Choose “Create password” below."
                  : "Could not create the account. If you already have one, sign in instead.",
              )
            } finally {
              setBusy(false)
            }
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="email">Work email</Label>
            <Input id="email" name="email" type="email" required autoComplete="email" placeholder="you@blackbole.com" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password" name="password" type="password" required minLength={8}
              autoComplete={flow === "signIn" ? "current-password" : "new-password"}
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? "Please wait…" : flow === "signIn" ? "Sign in" : "Create password & sign in"}
          </Button>
          <button
            type="button"
            className="w-full text-center text-sm text-muted-foreground hover:underline"
            onClick={() => { setFlow(flow === "signIn" ? "signUp" : "signIn"); setError(null) }}
          >
            {flow === "signIn" ? "First time? Create password" : "Already have a password? Sign in"}
          </button>
        </form>
      </div>
    </div>
  )
}
