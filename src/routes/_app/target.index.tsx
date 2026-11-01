import { Link, createFileRoute } from "@tanstack/react-router"
import { Loading, PageHeader } from "@/components/bits"
import { MarketingTargetView, useMarketingProgress } from "@/components/marketing-target-view"

// Open to every signed-in staff member on purpose: the marketing team works from this page. This page is solely
// Marketing's — the gross-sale target (counted from when an order is placed, not approved or delivered) and which
// products to sell to reach it. Customer Care / delivery has its own, separate page at /target/cx — nothing here
// depends on delivered-order economics (ad budget, profit, suggested pricing).
export const Route = createFileRoute("/_app/target/")({
  component: () => <TargetPage />,
})

function TargetPage() {
  const [data, refetch] = useMarketingProgress()
  return (
    <div className="space-y-4">
      <PageHeader title="Target" sub="This month's gross-sale target, and which products to sell to reach it" />
      <p className="text-xs text-muted-foreground">Looking for the delivered-revenue target, profit, and ad budget instead? That's Customer Care's own page — <Link to="/target/cx" className="font-medium text-tone-blue hover:underline">Target (CX) →</Link></p>
      {!data ? <Loading /> : <MarketingTargetView data={data} refetch={refetch} />}
    </div>
  )
}
