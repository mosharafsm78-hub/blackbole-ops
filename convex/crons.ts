import { cronJobs } from "convex/server"
import { internal } from "./_generated/api"

const crons = cronJobs()

// Pathao: statuses and payments every 10 minutes; every Payment Due order re-checked every 30 minutes (paused 12 am–8 am)
crons.interval("pathao status sync", { minutes: 10 }, internal.pathao.cronTick, { job: "status" })
crons.interval("pathao money sync", { minutes: 10 }, internal.pathao.cronTick, { job: "money" })
crons.interval("pathao payment due check", { minutes: 30 }, internal.pathao.cronTick, { job: "due" })
crons.interval("auto approve scheduled orders", { minutes: 5 }, internal.orders.runAutoApprove, {})

export default crons
