import { Outlet, createFileRoute } from "@tanstack/react-router"

/** Parent route for the /target family — Marketing's gross-sale page at /target (target.index.tsx) and Customer
 *  Care's delivered-revenue page at /target/cx (target.cx.tsx). Without an <Outlet /> here, TanStack Router
 *  makes target.cx.tsx a CHILD of this file and /target/cx would never render (same trap as /products — see
 *  products.tsx). This file owns no UI of its own. */
export const Route = createFileRoute("/_app/target")({
  component: () => <Outlet />,
})
