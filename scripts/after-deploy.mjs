// Runs on Vercel after the Convex functions are deployed.
// One-time login resets listed in one-time-resets.json (each runs once, tracked in the Convex env).
import { execSync } from "node:child_process"
import { readFileSync } from "node:fs"

if (!process.env.CONVEX_DEPLOY_KEY) process.exit(0)
const run = (cmd) => execSync(cmd, { stdio: ["ignore", "pipe", "pipe"] }).toString().trim()
const get = (name) => { try { return run(`npx convex env get ${name}`) } catch { return "" } }

const resets = JSON.parse(readFileSync(new URL("./one-time-resets.json", import.meta.url), "utf8"))
const done = new Set(get("ONE_TIME_RESETS_DONE").split(",").filter(Boolean))
for (const r of resets) {
  if (done.has(r.id)) continue
  try {
    const out = run(`npx convex run team:resetLoginByEmail ${JSON.stringify(JSON.stringify({ email: r.email }))}`)
    console.log(`Login reset ${r.id}: ${out}`)
    done.add(r.id)
    execSync(`npx convex env set ONE_TIME_RESETS_DONE -- ${JSON.stringify([...done].join(","))}`, { stdio: "inherit" })
  } catch (e) {
    console.log(`Login reset ${r.id} failed: ${e.message}`)
  }
}
