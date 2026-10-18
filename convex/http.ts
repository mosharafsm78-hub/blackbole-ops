import { httpRouter } from "convex/server"
import { auth } from "./auth"
import { webhook as shopifyWebhook } from "./shopify"
import { webhook as pathaoWebhook } from "./pathao"
import { orders as apiOrders } from "./publicApi"
import { handler as migrateHandler } from "./migrate"

const http = httpRouter()

auth.addHttpRoutes(http)

http.route({ path: "/shopify/orders", method: "POST", handler: shopifyWebhook })
http.route({ path: "/pathao/webhook", method: "POST", handler: pathaoWebhook })
http.route({ path: "/api/orders", method: "POST", handler: apiOrders })
http.route({ path: "/api/orders", method: "GET", handler: apiOrders })
http.route({ path: "/migrate", method: "POST", handler: migrateHandler })
http.route({ path: "/migrate", method: "OPTIONS", handler: migrateHandler })

export default http
