import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError } from '@/api/client'
import { useAuth } from '@/contexts/AuthContext'
import { Button, EmptyState, ErrorState, SeverityBadge, Spinner } from '@/components/ui'
import { contentService, type ContentItem, type FindingItem } from '@/services/content'

function Highlight({ text, start, end }: { text: string; start?: number; end?: number }) {
  if (start === undefined || end === undefined || start < 0 || end <= start || end > text.length) return <>{text}</>
  return <>{text.slice(0, start)}<mark className="rounded bg-amber-200 px-0.5 text-ink">{text.slice(start, end)}</mark>{text.slice(end)}</>
}

export default function ContentPage() {
  const { user } = useAuth()
  const org = user?.organizationId
  const qc = useQueryClient()
  const [selected, setSelected] = useState<ContentItem | null>(null)
  const [creating, setCreating] = useState(false)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [newTitle, setNewTitle] = useState('')
  const [newBody, setNewBody] = useState('')
  const [edits, setEdits] = useState<Record<string,string>>({})
  const [historyRevision,setHistoryRevision]=useState<string|null>(null)
  const [compareHistory,setCompareHistory]=useState(false)
  const list = useQuery({ queryKey: ['content', org], queryFn: () => contentService.list(org!), enabled: Boolean(org) })
  const load = (item: ContentItem) => { setSelected(item); setCreating(false); setTitle(item.title); setBody(item.body) }
  useEffect(() => {
    if (!selected && !creating && list.data?.length) load(list.data[0]!)
    else if (!selected && !creating && list.data && !list.data.length) setCreating(true)
  }, [list.data, selected, creating])
  const save = useMutation({ mutationFn: async () => {
    const target = selected!
    const item = await contentService.save(org!, target, { title, body })
    return { item, targetId: target._id }
  }, onSuccess: ({ item, targetId }) => {
    if (selected?._id === targetId) setSelected(item)
    qc.invalidateQueries({ queryKey: ['content', org] })
  } })
  const create = useMutation({ mutationFn: () => contentService.create(org!, { title: newTitle, body: newBody }), onSuccess: item => { setNewTitle(''); setNewBody(''); load(item); qc.invalidateQueries({ queryKey: ['content', org] }) } })
  const startScan = useMutation({ mutationFn: () => contentService.scan(org!, selected!._id, selected!.version), onSuccess: () => qc.invalidateQueries({ queryKey: ['scans', org, selected?._id] }) })
  const submit = useMutation({ mutationFn: () => contentService.submit(org!, selected!), onSuccess: async () => { const item = await contentService.get(org!, selected!._id); load(item); qc.invalidateQueries({ queryKey: ['content', org] }) } })
  const scans = useQuery({ queryKey: ['scans', org, selected?._id], queryFn: () => contentService.scans(org!, selected!._id), enabled: Boolean(org && selected), refetchInterval: q => q.state.data?.[0]?.status === 'queued' || q.state.data?.[0]?.status === 'running' ? 1500 : false })
  const latest = scans.data?.[0]
  const revisions=useQuery({queryKey:['revisions',org,selected?._id],queryFn:()=>contentService.revisions(org!,selected!._id),enabled:Boolean(org&&selected)})
  const historic=useQuery({queryKey:['revision',org,selected?._id,historyRevision],queryFn:()=>contentService.revision(org!,selected!._id,historyRevision!),enabled:Boolean(org&&selected&&historyRevision)})
  const comparison=useQuery({queryKey:['revision-compare',org,selected?._id,historyRevision],queryFn:()=>contentService.compare(org!,selected!._id,historyRevision!,selected!.currentRevisionId),enabled:Boolean(org&&selected&&historyRevision&&compareHistory)})
  const refreshedScan = useRef<string | null>(null)
  useEffect(() => {
    if (latest?.status === 'completed' && latest._id !== refreshedScan.current && selected) {
      refreshedScan.current = latest._id
      void contentService.get(org!, selected._id).then(load)
    }
  }, [latest?._id, latest?.status, selected?._id])
  const findings = useQuery({ queryKey: ['findings', org, latest?._id], queryFn: () => contentService.findings(org!, latest!._id), enabled: Boolean(org && latest?._id && latest.status === 'completed') })
  const decide = useMutation({ mutationFn: ({ finding, decision, replacement }: { finding: FindingItem; decision: 'accepted' | 'edited' | 'rejected'; replacement?: string }) => contentService.decide(org!, finding, selected!, decision, replacement), onSuccess: async () => { const updated = await contentService.get(org!, selected!._id); load(updated); qc.invalidateQueries({ queryKey: ['findings', org, latest?._id] }); qc.invalidateQueries({ queryKey: ['content', org] }) } })
  const dirty = useMemo(() => Boolean(selected && (title !== selected.title || body !== selected.body)), [selected, title, body])
  useEffect(() => {
    if (!dirty || !selected || !['draft', 'analyzed', 'changes_requested'].includes(selected.status)) return
    const timer = window.setTimeout(() => { if (!save.isPending) save.mutate() }, 900)
    return () => window.clearTimeout(timer)
  }, [dirty, title, body, selected, save.isPending])

  if (!org) return <EmptyState title="Choose an organization" hint="Create or join an organization before working with content." />
  if (list.isLoading) return <Spinner label="Loading content" />
  if (list.isError) return <ErrorState message={list.error.message} onRetry={() => list.refetch()} />
  const error = create.error ?? save.error ?? startScan.error ?? submit.error ?? decide.error
  return <div className="space-y-6">
    <header><h1 className="text-2xl font-semibold">Content workspace</h1><p className="mt-1 text-sm text-muted">Drafts are versioned. Scan a saved revision before submitting it for review.</p></header>
    <section className="grid gap-5 xl:grid-cols-[16rem_minmax(0,1fr)]">
      <aside className="space-y-4 rounded-lg border border-line bg-surface p-4">
        <h2 className="font-semibold">Documents</h2>
        <Button onClick={() => { setSelected(null); setCreating(true); setTitle(''); setBody('') }}>New document</Button>
        <ul className="space-y-1">{list.data?.map(item => <li key={item._id}><button onClick={() => load(item)} className={`w-full rounded p-2 text-left text-sm ${selected?._id === item._id ? 'bg-seal/10 font-medium' : 'hover:bg-line/50'}`}><span className="block truncate">{item.title}</span><span className="text-xs text-muted">{item.status} · v{item.version}</span></button></li>)}</ul>
        {!list.data?.length && <p className="text-sm text-muted">No documents yet.</p>}
      </aside>
      <div className="space-y-5">
        {!selected && creating ? <section className="space-y-3 rounded-lg border border-line bg-surface p-5"><h2 className="text-lg font-semibold">Create a document</h2><input aria-label="Document title" className="w-full rounded border border-line bg-surface p-2" placeholder="Title" maxLength={200} value={newTitle} onChange={e => setNewTitle(e.target.value)} /><textarea aria-label="Document text" className="min-h-56 w-full rounded border border-line bg-surface p-2" placeholder="Write your content" maxLength={200000} value={newBody} onChange={e => setNewBody(e.target.value)} /><Button disabled={!newTitle.trim() || !newBody.trim() || create.isPending} onClick={() => create.mutate()}>{create.isPending ? 'Creating…' : 'Create document'}</Button></section> : !selected ? <EmptyState title="Choose a document or start a new one"/> : <>
          <section className="space-y-3 rounded-lg border border-line bg-surface p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">Edit draft</h2><p className="text-xs text-muted">{selected.status} · revision {selected.version + 1}</p></div><div className="flex flex-wrap gap-2"><Button disabled={!dirty || save.isPending || !['draft','analyzed','changes_requested'].includes(selected.status)} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save revision'}</Button><Button disabled={dirty || startScan.isPending || !['draft','analyzed','changes_requested'].includes(selected.status)} onClick={() => startScan.mutate()}>{startScan.isPending ? 'Queueing…' : 'Run compliance scan'}</Button><Button disabled={dirty || submit.isPending || latest?.status !== 'completed' || !['analyzed','changes_requested'].includes(selected.status)} onClick={() => submit.mutate()}>{submit.isPending ? 'Submitting…' : 'Submit for review'}</Button></div></div><input aria-label="Document title" className="w-full rounded border border-line bg-surface p-2" maxLength={200} value={title} onChange={e => setTitle(e.target.value)} /><textarea aria-label="Document text" className="min-h-64 w-full rounded border border-line bg-surface p-3 font-mono text-sm" maxLength={200000} value={body} onChange={e => setBody(e.target.value)} /><p className="text-xs text-muted">{body.length.toLocaleString()} / 200,000 characters {dirty ? '· Unsaved changes' : '· Saved'}</p></section>
          <section className="space-y-3 rounded-lg border border-line bg-surface p-5"><h2 className="font-semibold">Revision history</h2>{revisions.isLoading?<Spinner label="Loading revisions"/>:revisions.isError?<ErrorState message={revisions.error.message} onRetry={()=>revisions.refetch()}/>:<ul className="space-y-2">{revisions.data?.map(r=><li key={r._id} className="flex flex-wrap items-center justify-between gap-2 text-sm"><span>Revision {r.number} · {new Date(r.createdAt).toLocaleString()}{r._id===selected.currentRevisionId?' · Current':''}</span>{r._id!==selected.currentRevisionId&&<Button className="bg-surface text-ink ring-1 ring-line" onClick={()=>{setHistoryRevision(r._id);setCompareHistory(false)}}>Inspect</Button>}</li>)}</ul>}{historyRevision&&<div className="space-y-2 border-t border-line pt-3">{historic.isLoading?<Spinner label="Loading revision"/>:historic.data&&<><p className="font-medium">{historic.data.title} · revision {historic.data.number}</p><pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-line/30 p-3 text-sm">{historic.data.body}</pre><Button className="bg-surface text-ink ring-1 ring-line" onClick={()=>setCompareHistory(true)}>Compare with current revision</Button></>}{comparison.isLoading&&compareHistory&&<Spinner label="Comparing revisions"/>}{comparison.data&&<div className="rounded bg-line/30 p-3 text-sm"><p>Change at character {comparison.data.change.start}</p>{comparison.data.change.removed&&<p><strong>Removed:</strong> {comparison.data.change.removed}</p>}{comparison.data.change.added&&<p><strong>Added:</strong> {comparison.data.change.added}</p>}</div>}</div>}</section>
          <section className="space-y-3 rounded-lg border border-line bg-surface p-5">
            <div className="flex items-center justify-between"><h2 className="text-lg font-semibold">Compliance findings</h2><span className="text-xs text-muted">{latest ? `Scan: ${latest.status}` : 'No scan yet'}</span></div>
            {latest?.status === 'failed' && <p role="alert" className="text-sm text-sev-critical">The scan failed. Retry after the analysis service is available.</p>}
            {latest && latest.revisionId !== selected.currentRevisionId && <p className="text-sm text-amber-700">These results belong to an older revision. Save and rescan to refresh them.</p>}
            {findings.isLoading && <Spinner label="Loading findings" />}{findings.isError && <ErrorState message={findings.error.message} onRetry={() => findings.refetch()} />}
            {findings.data?.length ? <ul className="space-y-3">{findings.data.map(f => <li key={f._id} className="space-y-2 rounded border border-line p-3">
              <div className="flex flex-wrap items-center gap-2"><SeverityBadge s={f.severity} /><span className="text-xs text-muted">{f.category}</span><span className="ml-auto text-xs text-muted">{f.status}</span></div>
              <p className="text-sm"><Highlight text={body} start={f.start} end={f.end} /></p><p className="text-sm">{f.message}</p>
              {f.suggestion && <label className="block text-sm">Suggested correction<textarea className="mt-1 w-full rounded border border-line bg-surface p-2" maxLength={10000} value={edits[f._id] ?? f.suggestion} onChange={e=>setEdits(prev=>({...prev,[f._id]:e.target.value}))}/></label>}
              {f.evidence.map((e,i) => <blockquote key={`${e.sourceId}-${i}`} className="border-l-2 border-seal/40 pl-3 text-xs text-muted">Evidence: “{e.quote}”</blockquote>)}
              {f.status === 'open' && latest?.revisionId === selected.currentRevisionId && <div className="flex flex-wrap gap-2"><Button disabled={decide.isPending || !f.suggestion} onClick={() => decide.mutate({finding:f,decision:'accepted'})}>Accept suggestion</Button><Button disabled={decide.isPending || !(edits[f._id]??f.suggestion)?.trim()} className="bg-surface text-ink ring-1 ring-line" onClick={() => decide.mutate({finding:f,decision:'edited',replacement:edits[f._id]??f.suggestion??''})}>Use my edit</Button><Button disabled={decide.isPending} className="bg-surface text-ink ring-1 ring-line" onClick={() => decide.mutate({finding:f,decision:'rejected'})}>Reject finding</Button></div>}
            </li>)}</ul> : latest?.status === 'completed' && <EmptyState title="No findings" hint="This revision passed the configured checks." />}
          </section>
        </>}
      </div>
    </section>
    {error && <p role="alert" className="text-sm text-sev-critical">{error instanceof ApiError ? error.message : error.message}</p>}
  </div>
}
