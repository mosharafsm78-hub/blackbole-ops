// Runs on Vercel before each build. On the first build it creates the
// sign-in keys Convex Auth needs and stores them in the Convex deployment.
// Nothing secret is kept in the repository.
import { execSync } from "node:child_process"
import { exportJWK, exportPKCS8, generateKeyPair } from "jose"

const run = (cmd) => execSync(cmd, { stdio: ["ignore", "pipe", "pipe"] }).toString().trim()
const get = (name) => {
  try { return run(`npx convex env get ${name}`) } catch { return "" }
}
const set = (name, value) => {
  execSync(`npx convex env set ${name} -- ${JSON.stringify(value)}`, { stdio: "inherit" })
}

if (!process.env.CONVEX_DEPLOY_KEY) {
  console.log("CONVEX_DEPLOY_KEY not set; skipping Convex env setup")
  process.exit(0)
}

if (!get("JWT_PRIVATE_KEY")) {
  const keys = await generateKeyPair("RS256", { extractable: true })
  const privateKey = await exportPKCS8(keys.privateKey)
  const publicKey = await exportJWK(keys.publicKey)
  set("JWT_PRIVATE_KEY", privateKey.trimEnd().replace(/\n/g, " "))
  set("JWKS", JSON.stringify({ keys: [{ use: "sig", ...publicKey }] }))
  console.log("Created Convex Auth signing keys")
}

const site = process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : ""
if (site && get("SITE_URL") !== site) {
  set("SITE_URL", site)
  console.log(`SITE_URL set to ${site}`)
}
