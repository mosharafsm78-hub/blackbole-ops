import { Link, createFileRoute } from "@tanstack/react-router"
import { Loading, PageHeader } from "@/components/bits"
import { TargetPlanView, useTargetProgress } from "@/components/revenue-target-card"

// Customer Care / delivery's own page — the delivered-revenue target (counted only once an order is marked
// Delivered), daily pacing toward it, profit, and the marketing budget it needs. The separate /target page is
// Marketing's: the gross-sale target, counted from the moment an order is placed. Both pull from the same
// orders and stock; they differ only in which orders count and when.
export const Route = createFileRoute("/_app/target/cx")({
  component: () => <CxTargetPage />,
})

function CxTargetPage() {
  const [data, refetch] = useTargetProgress()
  return (
    <div className="space-y-4">
      <PageHeader title="Target (CX)" sub="This month's delivered-revenue target — profit, ad budget, and what to deliver to reach it" />
      <p className="text-xs text-muted-foreground">Looking for the gross-sale target instead? That's Marketing's own page — <Link to="/target" className="font-medium text-tone-blue hover:underline">Target →</Link></p>
      {!data ? <Loading /> : <TargetPlanView data={data} refetch={refetch} />}
    </div>
  )
}
