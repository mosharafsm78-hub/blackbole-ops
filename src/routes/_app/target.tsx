import { createFileRoute, Link } from "@tanstack/react-router"
import { Loading, PageHeader } from "@/components/bits"
import { useCan } from "@/components/app-shell"
import { monthLabel, TargetPlanView, useTargetProgress } from "@/components/revenue-target-card"

// Open to every signed-in staff member on purpose: the marketing team works from this page. Ad spend, profit and
// running costs are filtered out on the server for anyone without the right permission.
export const Route = createFileRoute("/_app/target")({
  component: () => <TargetPage />,
})

function TargetPage() {
  const can = useCan()
  const data = useTargetProgress()
  return (
    <div className="space-y-4">
      <PageHeader title="Target" sub="Daily and monthly revenue target, what to sell, and the marketing budget" />
      {!data ? <Loading /> : !data.target || !data.plan ? (
        <div className="rounded-xl border border-dashed bg-card p-6 text-sm">
          <p className="font-semibold">No revenue target for {monthLabel(data.month)} yet.</p>
          {can("team.manage") && <p className="mt-1 text-muted-foreground">Set one in <Link to="/settings" className="font-medium text-tone-blue hover:underline">Settings → KPI</Link> and this page fills itself in.</p>}
        </div>
      ) : <TargetPlanView data={data} />}
    </div>
  )
}
