import { useMutation,useQuery,useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/contexts/AuthContext'
import { Button,EmptyState,ErrorState,Spinner } from '@/components/ui'
import { reportingService } from '@/services/reporting'
export default function NotificationsPage(){
 const org=useAuth().user?.organizationId;const qc=useQueryClient()
 const q=useQuery({queryKey:['notifications',org],queryFn:()=>reportingService.notifications(org!),enabled:Boolean(org)})
 const mark=useMutation({mutationFn:(id:string)=>reportingService.markRead(org!,id),onSuccess:()=>qc.invalidateQueries({queryKey:['notifications',org]})})
 if(!org)return <EmptyState title="Choose an organization"/>;if(q.isLoading)return <Spinner label="Loading notifications"/>;if(q.isError)return <ErrorState message={q.error.message} onRetry={()=>q.refetch()}/>
 return <div className="space-y-5"><header><h1 className="text-2xl font-semibold">Notifications</h1><p className="text-sm text-muted">Organization workflow updates for your account.</p></header>{q.data?.length?<ul className="divide-y divide-line rounded-lg border border-line bg-surface">{q.data.map(n=><li key={n._id} className="flex items-start gap-4 p-4"><div className="min-w-0 flex-1"><p className="font-medium">{n.title}</p><p className="text-sm text-muted">{n.message}</p><time className="text-xs text-muted">{new Date(n.createdAt).toLocaleString()}</time></div>{!n.readAt&&<Button className="bg-surface text-ink ring-1 ring-line" disabled={mark.isPending} onClick={()=>mark.mutate(n._id)}>Mark read</Button>}</li>)}</ul>:<EmptyState title="You’re all caught up"/>}{mark.error&&<p role="alert" className="text-sm text-sev-critical">{mark.error.message}</p>}</div>
}
