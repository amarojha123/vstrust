import { useQuery } from '@tanstack/react-query'
import { useAuth } from '@/contexts/AuthContext'
import { dashboardService } from '@/services/dashboard'
import { EmptyState, ErrorState, Spinner } from '@/components/ui'

const pct = (value: number | null) => value === null ? '—' : `${Math.round(value * 100)}%`
const duration = (value: number | null) => value === null ? '—' : value < 60_000 ? `${Math.round(value / 1000)} sec` : `${(value / 60_000).toFixed(1)} min`

export default function AnalyticsPage() {
  const { user } = useAuth()
  const org = user?.organizationId
  const q = useQuery({ queryKey: ['analytics', org], queryFn: () => dashboardService.metrics(org!), enabled: Boolean(org) })
  if (!org) return <EmptyState title="Choose an organization" />
  if (q.isLoading) return <Spinner label="Loading analytics" />
  if (q.isError) return <ErrorState message={q.error.message} onRetry={() => q.refetch()} />
  const d = q.data!
  return <div className="space-y-6"><header><h1 className="text-2xl font-semibold">Analytics</h1><p className="text-sm text-muted">Persisted activity for the last 30 days.</p></header>
    <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{[['Submissions',d.submissions],['Approved',d.approvals],['Rejected',d.rejections],['Changes requested',d.changesRequested],['Approval rate',pct(d.approvalRate)],['Average review time',duration(d.reviewTurnaround.averageMs)],['Review sample',d.reviewTurnaround.sampleSize],['Correction rate',pct(d.corrections.rate)]].map(([label,value])=><div key={String(label)} className="rounded-lg border border-line bg-surface p-4"><dt className="text-sm text-muted">{label}</dt><dd className="mt-1 text-2xl font-semibold">{value}</dd></div>)}</dl>
    <div className="grid gap-5 lg:grid-cols-2"><section className="rounded-lg border border-line bg-surface p-5"><h2 className="mb-3 font-semibold">Findings by category</h2>{d.findingsByCategory.length?<ul className="space-y-2">{d.findingsByCategory.map(x=><li key={x.category} className="flex justify-between text-sm"><span>{x.category}</span><span>{x.count}</span></li>)}</ul>:<EmptyState title="No findings in this period" />}</section>
    <section className="rounded-lg border border-line bg-surface p-5"><h2 className="mb-3 font-semibold">Corrections</h2><ul className="space-y-2 text-sm"><li className="flex justify-between"><span>Accepted</span><span>{d.corrections.accepted}</span></li><li className="flex justify-between"><span>Edited</span><span>{d.corrections.edited}</span></li><li className="flex justify-between"><span>Rejected</span><span>{d.corrections.rejected}</span></li></ul></section></div>
  </div>
}
