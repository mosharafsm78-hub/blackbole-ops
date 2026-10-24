// Runs on Vercel after the Convex functions are deployed.
// One-time jobs listed in one-time-resets.json — each runs once, tracked in the Convex env ONE_TIME_RESETS_DONE.
import { execSync } from "node:child_process"
import { readFileSync } from "node:fs"

if (!process.env.CONVEX_DEPLOY_KEY) process.exit(0)
const run = (cmd) => execSync(cmd, { stdio: ["ignore", "pipe", "pipe"] }).toString().trim()
const get = (name) => { try { return run(`npx convex env get ${name}`) } catch { return "" } }

const jobs = JSON.parse(readFileSync(new URL("./one-time-resets.json", import.meta.url), "utf8"))
const done = new Set(get("ONE_TIME_RESETS_DONE").split(",").filter(Boolean))
for (const j of jobs) {
  if (done.has(j.id)) continue
  try {
    const out = run(`npx convex run ${j.fn} ${JSON.stringify(JSON.stringify(j.args ?? {}))}`)
    console.log(`One-time job ${j.id}: ${out}`)
    done.add(j.id)
    execSync(`npx convex env set ONE_TIME_RESETS_DONE -- ${JSON.stringify([...done].join(","))}`, { stdio: "inherit" })
  } catch (e) {
    console.log(`One-time job ${j.id} failed: ${e.message}`)
  }
}
