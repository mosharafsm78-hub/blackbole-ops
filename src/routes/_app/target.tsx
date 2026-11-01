import { createFileRoute } from "@tanstack/react-router"
import { Loading, PageHeader } from "@/components/bits"
import { MarketingTargetView, useMarketingProgress } from "@/components/marketing-target-view"

// Open to every signed-in staff member on purpose: the marketing team works from this page. This page is solely
// Marketing's — the gross-sale target (counted from when an order is placed, not approved or delivered) and which
// products to sell to reach it. Customer Care / delivery gets its own, separate page later; nothing here depends
// on delivered-order economics (ad budget, profit, suggested pricing).
export const Route = createFileRoute("/_app/target")({
  component: () => <TargetPage />,
})

function TargetPage() {
  const [data, refetch] = useMarketingProgress()
  return (
    <div className="space-y-4">
      <PageHeader title="Target" sub="This month's gross-sale target, and which products to sell to reach it" />
      {!data ? <Loading /> : <MarketingTargetView data={data} refetch={refetch} />}
    </div>
  )
}
