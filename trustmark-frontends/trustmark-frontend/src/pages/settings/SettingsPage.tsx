import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/contexts/AuthContext'
import { Button, EmptyState, ErrorState, Spinner } from '@/components/ui'
import { organizationService } from '@/services/organization'
import { reportingService } from '@/services/reporting'
import type { Role } from '@/types'

const roles:Role[]=['admin','creator','reviewer','auditor']
export default function SettingsPage(){
  const org=useAuth().user?.organizationId
  const qc=useQueryClient()
  const [email,setEmail]=useState('')
  const [role,setRole]=useState<Role>('creator')
  const details=useQuery({queryKey:['org-details',org],queryFn:()=>organizationService.details(org!),enabled:Boolean(org)})
  const members=useQuery({queryKey:['org-members',org],queryFn:()=>organizationService.members(org!),enabled:Boolean(org)})
  const invitations=useQuery({queryKey:['org-invitations',org],queryFn:()=>organizationService.invitations(org!),enabled:Boolean(org)})
  const audit=useQuery({queryKey:['audit-events',org],queryFn:()=>reportingService.audit(org!),enabled:Boolean(org)})
  const invalidate=()=>{qc.invalidateQueries({queryKey:['org-members',org]});qc.invalidateQueries({queryKey:['org-invitations',org]})}
  const invite=useMutation({mutationFn:()=>organizationService.invite(org!,email,role),onSuccess:()=>{setEmail('');invalidate()}})
  const update=useMutation({mutationFn:({id,next}:{id:string;next:Role})=>organizationService.setRole(org!,id,next),onSuccess:invalidate})
  const remove=useMutation({mutationFn:(id:string)=>organizationService.remove(org!,id),onSuccess:invalidate})
  if(!org)return <EmptyState title="Choose an organization"/>
  if(details.isLoading||members.isLoading||invitations.isLoading||audit.isLoading)return <Spinner label="Loading organization settings"/>
  const error=details.error??members.error??invitations.error??audit.error??invite.error??update.error??remove.error
  return <div className="space-y-6"><header><h1 className="text-2xl font-semibold">Organization settings</h1><p className="text-sm text-muted">{details.data?.name} · {details.data?.slug}</p></header>
    {(details.isError||members.isError||invitations.isError||audit.isError)&&<ErrorState message={error?.message??'Could not load organization data'} onRetry={()=>{void details.refetch();void members.refetch();void invitations.refetch();void audit.refetch()}}/>}
    <section className="space-y-3 rounded-lg border border-line bg-surface p-5"><h2 className="font-semibold">Invite a teammate</h2><form className="flex flex-wrap gap-2" onSubmit={e=>{e.preventDefault();invite.mutate()}}><input type="email" required maxLength={254} aria-label="Invitee email" className="min-w-64 flex-1 rounded border border-line bg-surface p-2" value={email} onChange={e=>setEmail(e.target.value)}/><select aria-label="Invitee role" className="rounded border border-line bg-surface p-2" value={role} onChange={e=>setRole(e.target.value as Role)}>{roles.map(r=><option key={r}>{r}</option>)}</select><Button disabled={invite.isPending||!email.trim()}>{invite.isPending?'Sending…':'Send invitation'}</Button></form><p className="text-xs text-muted">Invitation email delivery requires SMTP. In local development, use the configured Mailpit inbox.</p></section>
    <section className="space-y-3 rounded-lg border border-line bg-surface p-5"><h2 className="font-semibold">Members</h2>{members.data?.length?<ul className="divide-y divide-line">{members.data.map(m=><li key={m._id} className="flex flex-wrap items-center gap-3 py-3"><div className="min-w-48 flex-1"><p className="font-medium">{m.userId.name}</p><p className="text-xs text-muted">{m.userId.email}</p></div><select aria-label={`Role for ${m.userId.email}`} className="rounded border border-line bg-surface p-2" value={m.role} onChange={e=>update.mutate({id:m._id,next:e.target.value as Role})}>{roles.map(r=><option key={r}>{r}</option>)}</select><Button className="bg-surface text-ink ring-1 ring-line" disabled={remove.isPending} onClick={()=>remove.mutate(m._id)}>Remove</Button></li>)}</ul>:<EmptyState title="No members"/>}</section>
    <section className="space-y-3 rounded-lg border border-line bg-surface p-5"><h2 className="font-semibold">Pending invitations</h2>{invitations.data?.length?<ul className="space-y-2">{invitations.data.map(i=><li key={i._id} className="flex justify-between text-sm"><span>{i.email} · {i.role}</span><time className="text-muted">Expires {new Date(i.expiresAt).toLocaleDateString()}</time></li>)}</ul>:<EmptyState title="No pending invitations"/>}</section>
    <section className="space-y-3 rounded-lg border border-line bg-surface p-5"><h2 className="font-semibold">Audit log</h2>{audit.data?.length?<ul className="space-y-2">{audit.data.map(e=><li key={e._id} className="flex flex-wrap justify-between gap-2 border-b border-line py-2 text-sm"><span>{e.action} · {e.resourceType}</span><time className="text-muted">{new Date(e.createdAt).toLocaleString()}</time></li>)}</ul>:<EmptyState title="No recent audit events"/>}</section>
    {error&&<p role="alert" className="text-sm text-sev-critical">{error.message}</p>}
  </div>
}
