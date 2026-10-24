import { cronJobs } from "convex/server"
import { internal } from "./_generated/api"

const crons = cronJobs()

crons.interval("pathao status sync", { minutes: 30 }, internal.pathao.syncAll, {})
crons.interval("pathao money sync", { minutes: 30 }, internal.pathao.syncMoney, {})
crons.interval("auto approve scheduled orders", { minutes: 5 }, internal.orders.runAutoApprove, {})

export default crons
