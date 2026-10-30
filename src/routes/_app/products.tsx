import { Outlet, createFileRoute } from "@tanstack/react-router"

/** Parent route for the /products family.
 *
 *  TanStack Router makes `products.$productId.tsx` a CHILD of `products.tsx`. Without an <Outlet /> here,
 *  navigating to /products/$productId mounts only the parent and the detail page never renders — which is
 *  exactly why every order line-item link looked like it fell back to the /products catalog list.
 *  This file owns no UI: the catalog list is products.index.tsx, the detail is products.$productId.tsx.
 */
export const Route = createFileRoute("/_app/products")({
  component: () => <Outlet />,
})
