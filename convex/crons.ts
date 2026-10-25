import { cronJobs } from "convex/server"
import { internal } from "./_generated/api"

const crons = cronJobs()

// Pathao: statuses and payments every 10 minutes; every Payment Due order re-checked every 30 minutes
crons.interval("pathao status sync", { minutes: 10 }, internal.pathao.syncAll, {})
crons.interval("pathao money sync", { minutes: 10 }, internal.pathao.syncMoney, {})
crons.interval("pathao payment due check", { minutes: 30 }, internal.pathao.checkDue, {})
crons.interval("auto approve scheduled orders", { minutes: 5 }, internal.orders.runAutoApprove, {})

export default crons
