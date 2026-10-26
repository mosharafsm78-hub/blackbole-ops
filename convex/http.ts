import { httpRouter } from "convex/server"
import { auth } from "./auth"
import { webhook as shopifyWebhook } from "./shopify"
import { webhook as pathaoWebhook } from "./pathao"
import { orders as apiOrders } from "./publicApi"
import { handler as migrateHandler } from "./migrate"
import { codLeadHttp } from "./checkouts"
import { orders as marketingOrders, stock as marketingStock } from "./marketingFeed"
import { catalogHttp as websiteCatalog } from "./website"
import { feedHttp as discountFeed, checkHttp as discountCheck } from "./discounts"
import { statusHttp as orderStatus } from "./orderStatus"
import { subscribeHttp } from "./subscribers"
import { contentHttp as websiteContent } from "./content"
import { themeHttp as websiteTheme } from "./themes"
import { reviewsHttp as websiteReviews } from "./reviews"

const http = httpRouter()

auth.addHttpRoutes(http)

http.route({ path: "/shopify/orders", method: "POST", handler: shopifyWebhook })
http.route({ path: "/pathao/webhook", method: "POST", handler: pathaoWebhook })
http.route({ path: "/api/orders", method: "POST", handler: apiOrders })
http.route({ path: "/api/orders", method: "GET", handler: apiOrders })
http.route({ path: "/migrate", method: "POST", handler: migrateHandler })
http.route({ path: "/migrate", method: "OPTIONS", handler: migrateHandler })
// Website COD popup: customer's number as soon as it's typed (abandoned COD form leads)
http.route({ path: "/cod-lead", method: "POST", handler: codLeadHttp })
http.route({ path: "/cod-lead", method: "OPTIONS", handler: codLeadHttp })
// Read-only feed for BlackBole Marketing OS (needs MARKETING_FEED_KEY)
http.route({ path: "/marketing/orders", method: "GET", handler: marketingOrders })
http.route({ path: "/marketing/stock", method: "GET", handler: marketingStock })
// Website build reads products + collections from here (same MARKETING_FEED_KEY)
http.route({ path: "/website/catalog", method: "GET", handler: websiteCatalog })
// Website discount codes (same key): live list, and the one-per-customer check
http.route({ path: "/website/discounts", method: "GET", handler: discountFeed })
http.route({ path: "/website/discount-check", method: "GET", handler: discountCheck })
// Website "Track your order": invoice + mobile → safe status (no key; rate-limited per IP)
http.route({ path: "/website/order-status", method: "GET", handler: orderStatus })
// Website newsletter sign-ups (same key)
http.route({ path: "/website/subscribe", method: "POST", handler: subscribeHttp })
// Website pages, blog, menus, redirects and store settings (same MARKETING_FEED_KEY)
http.route({ path: "/website/content", method: "GET", handler: websiteContent })
// Website theme (Website → Themes): ?which=live|draft (same key)
http.route({ path: "/website/theme", method: "GET", handler: websiteTheme })
// Product reviews (Website → Reviews): GET published ones for the build, POST a new one (pending) (same key)
http.route({ path: "/website/reviews", method: "GET", handler: websiteReviews })
http.route({ path: "/website/reviews", method: "POST", handler: websiteReviews })

export default http
