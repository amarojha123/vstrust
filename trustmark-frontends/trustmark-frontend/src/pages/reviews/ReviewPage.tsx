import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/contexts/AuthContext'
import { Button, EmptyState, ErrorState, Spinner } from '@/components/ui'
import { contentService, type ContentItem } from '@/services/content'

export default function ReviewPage() {
  const user=useAuth().user
  const org=user?.organizationId
  const qc=useQueryClient()
  const [selected,setSelected]=useState<ContentItem|null>(null)
  const [comment,setComment]=useState('')
  const inReview=useQuery({queryKey:['review-queue',org,'in_review'],queryFn:()=>contentService.list(org!,'in_review'),enabled:Boolean(org),refetchInterval:10000})
  const resubmitted=useQuery({queryKey:['review-queue',org,'resubmitted'],queryFn:()=>contentService.list(org!,'resubmitted'),enabled:Boolean(org),refetchInterval:10000})
  const queue=[...(inReview.data??[]),...(resubmitted.data??[])]
  const decide=useMutation({mutationFn:(decision:'approved'|'rejected'|'changes_requested')=>contentService.review(org!,selected!,decision,comment),onSuccess:()=>{setSelected(null);setComment('');qc.invalidateQueries({queryKey:['review-queue',org]})}})
  if(!org)return <EmptyState title="Choose an organization" />
  if(inReview.isLoading||resubmitted.isLoading)return <Spinner label="Loading review queue" />
  if(inReview.isError)return <ErrorState message={inReview.error.message} onRetry={()=>inReview.refetch()} />
  if(resubmitted.isError)return <ErrorState message={resubmitted.error.message} onRetry={()=>resubmitted.refetch()} />
  return <div className="space-y-6"><header><h1 className="text-2xl font-semibold">Review queue</h1><p className="text-sm text-muted">Decisions are recorded against the exact submitted revision.</p></header>
    {!queue.length?<EmptyState title="Nothing waiting for review" hint="Submitted content will appear here."/>:<div className="grid gap-5 xl:grid-cols-[20rem_minmax(0,1fr)]"><ul className="divide-y divide-line rounded-lg border border-line bg-surface">{queue.map(item=><li key={item._id}><button onClick={()=>{setSelected(item);setComment('')}} className={`w-full p-4 text-left ${selected?._id===item._id?'bg-seal/10':'hover:bg-line/40'}`}><span className="block font-medium">{item.title}</span><span className="text-xs text-muted">{item.status} · v{item.version}</span></button></li>)}</ul>
    {selected?<section className="space-y-4 rounded-lg border border-line bg-surface p-5"><div><h2 className="text-lg font-semibold">{selected.title}</h2><p className="text-sm text-muted">Revision {selected.version} · {selected.status}</p></div><pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap rounded bg-line/30 p-4 font-sans text-sm">{selected.body}</pre><label className="block text-sm">Reviewer comment<textarea className="mt-1 min-h-24 w-full rounded border border-line bg-surface p-2" value={comment} onChange={e=>setComment(e.target.value)} maxLength={4000} placeholder="Required for every decision"/></label><div className="flex flex-wrap gap-2"><Button disabled={!comment.trim()||decide.isPending||selected.createdBy===user?.id} onClick={()=>decide.mutate('approved')}>Approve</Button><Button disabled={!comment.trim()||decide.isPending} className="bg-surface text-ink ring-1 ring-line" onClick={()=>decide.mutate('changes_requested')}>Request changes</Button><Button disabled={!comment.trim()||decide.isPending} className="bg-surface text-ink ring-1 ring-line" onClick={()=>decide.mutate('rejected')}>Reject</Button></div>{selected.createdBy===user?.id&&<p className="text-sm text-muted">You cannot approve your own submission.</p>}{decide.error&&<p role="alert" className="text-sm text-sev-critical">{decide.error.message}</p>}</section>:<EmptyState title="Select a submission"/>}</div>}
  </div>
}
