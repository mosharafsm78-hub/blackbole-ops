// Runs on Vercel before each build. On the first build it creates the
// sign-in keys Convex Auth needs and stores them in the Convex deployment.
// Nothing secret is kept in the repository.
import { execSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
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

const site = process.env.SITE_URL_PUBLIC || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "")
if (site && get("SITE_URL") !== site) {
  set("SITE_URL", site)
  console.log(`SITE_URL set to ${site}`)
}

// Pathao proxy: Convex can't reach Pathao directly, so it calls this site's /api/pathao-proxy.
let proxySecret = get("PATHAO_PROXY_SECRET")
if (!proxySecret) {
  proxySecret = randomBytes(24).toString("hex")
  set("PATHAO_PROXY_SECRET", proxySecret)
}
if (site && get("PATHAO_PROXY_URL") !== `${site}/api/pathao-proxy`) set("PATHAO_PROXY_URL", `${site}/api/pathao-proxy`)
const secretFile = "src/server/proxy-secret.ts"
writeFileSync(secretFile, readFileSync(secretFile, "utf8").replace("__PATHAO_PROXY_SECRET__", proxySecret))
console.log("Pathao proxy configured")
