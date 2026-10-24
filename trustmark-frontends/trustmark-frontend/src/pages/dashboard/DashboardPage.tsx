import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { dashboardService } from '@/services/dashboard'
import { authService } from '@/services/auth'
import { useAuth } from '@/contexts/AuthContext'
import EmailVerificationNotice from '@/components/auth/EmailVerificationNotice'
import { Button, EmptyState, ErrorState, SeverityBadge, Spinner } from '@/components/ui'
import type { Severity } from '@/types'

export default function DashboardPage() {
  const { user, setUser } = useAuth()
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const organizations = useQuery({ queryKey: ['organizations'], queryFn: dashboardService.organizations })
  const organization = organizations.data?.[0]
  const metrics = useQuery({ queryKey: ['analytics', organization?._id], queryFn: () => dashboardService.metrics(organization!._id), enabled: Boolean(organization) })
  const create = useMutation({ mutationFn: dashboardService.createOrganization, onSuccess: async () => {
    queryClient.invalidateQueries({ queryKey: ['organizations'] })
    setUser(await authService.me())
  } })

  if (organizations.isLoading) return <Spinner label="Loading organizations" />
  if (organizations.isError) return <ErrorState message={organizations.error.message} onRetry={() => organizations.refetch()} />
  if (!organization) return <section className="max-w-xl space-y-4">
    <h1 className="text-2xl font-semibold">Set up your organization</h1>
    <p className="text-sm text-muted">Create an organization to start managing brand compliance.</p>
    <EmailVerificationNotice />
    {user?.emailVerified && <p role="status" className="text-sm text-seal">Email verified. You can create your organization.</p>}
    <form className="space-y-3" onSubmit={e => { e.preventDefault(); if (user?.emailVerified && !create.isPending) create.mutate({ name, slug }) }}>
      <label className="block text-sm">Organization name<input className="mt-1 w-full rounded border border-line bg-surface p-2" required maxLength={120} value={name} onChange={e => setName(e.target.value)} /></label>
      <label className="block text-sm">URL slug<input className="mt-1 w-full rounded border border-line bg-surface p-2" required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" minLength={2} maxLength={80} value={slug} onChange={e => setSlug(e.target.value)} /></label>
      {create.error && <p role="alert" className="text-sm text-sev-critical">{create.error.message}</p>}
      <Button type="submit" loading={create.isPending} disabled={!user?.emailVerified}>{create.isPending ? 'Creating organization…' : 'Create organization'}</Button>
    </form>
  </section>
  if (metrics.isLoading) return <Spinner label="Loading analytics" />
  if (metrics.isError) return <ErrorState message={metrics.error.message} onRetry={() => metrics.refetch()} />
  const d = metrics.data!
  const stats = [['Submissions', d.submissions], ['Approved', d.approvals], ['Rejected', d.rejections], ['Changes requested', d.changesRequested]] as const
  const severity = Object.fromEntries(d.findingsBySeverity.map(row => [row.severity, row.count])) as Partial<Record<Severity, number>>
  return <div className="space-y-8"><div><h1 className="text-2xl font-semibold">Dashboard</h1><p className="text-sm text-muted">{organization.name}</p></div>
    <dl className="grid grid-cols-2 gap-4 lg:grid-cols-4">{stats.map(([k, v]) => <div key={k} className="rounded-lg border border-line bg-surface p-4"><dt className="text-sm text-muted">{k}</dt><dd className="text-3xl font-semibold">{v}</dd></div>)}</dl>
    <section><h2 className="mb-2 text-lg font-semibold">Findings by severity</h2><ul className="flex flex-wrap gap-4">{(['critical', 'high', 'medium', 'low', 'info'] as Severity[]).map(s => <li key={s} className="flex items-center gap-2"><SeverityBadge s={s} />{severity[s] ?? 0}</li>)}</ul></section>
    <section><h2 className="mb-2 text-lg font-semibold">Frequently violated rules</h2>{d.frequentlyViolatedRules.length ? <ol className="space-y-1">{d.frequentlyViolatedRules.map((r, i) => <li key={`${r.ruleType}-${r.ruleId}-${i}`} className="flex justify-between border-b border-line py-1 text-sm"><span>{r.ruleType ?? 'Rule'}{r.ruleId ? ` · ${r.ruleId}` : ''}</span><span>{r.count}</span></li>)}</ol> : <EmptyState title="No violations yet" hint="Rule analytics appear after completed compliance scans." />}</section>
  </div>
}
