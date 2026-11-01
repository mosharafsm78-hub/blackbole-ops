import { Link, createFileRoute } from "@tanstack/react-router"
import { Loading, PageHeader } from "@/components/bits"
import { TargetPlanView, useTargetProgress } from "@/components/revenue-target-card"

// Customer Care / delivery's own page — the delivered-revenue target (counted only once an order is marked
// Delivered), what Marketing is booking (so CX can see what's coming), daily pacing, profit, and which products
// are still owed. Deliberately none of Marketing's own job — what to sell, ad budget, restock, stock levels,
// suggested pricing; that's purchasing/Marketing's concern, on its own /target page. CX's job is delivering what
// Marketing has already brought in, not deciding what gets sold or bought.
export const Route = createFileRoute("/_app/target/cx")({
  component: () => <CxTargetPage />,
})

function CxTargetPage() {
  const [data] = useTargetProgress()
  return (
    <div className="space-y-4">
      <PageHeader title="Target (CX)" sub="This month's delivered-revenue target, and how it tracks against what Marketing is booking" />
      <p className="text-xs text-muted-foreground">Looking for the gross-sale target instead? That's Marketing's own page — <Link to="/target" className="font-medium text-tone-blue hover:underline">Target →</Link></p>
      {!data ? <Loading /> : <TargetPlanView data={data} />}
    </div>
  )
}
