import { api } from '@/api/client'
export type Notification={_id:string;title:string;message:string;type:string;resourceId?:string;readAt?:string|null;createdAt:string}
export type AuditEvent={_id:string;action:string;resourceType:string;resourceId?:string;createdAt:string;metadata:Record<string,unknown>}
const base=(org:string)=>`/organizations/${org}`
export const reportingService={
  notifications:(org:string)=>api<Notification[]>(`${base(org)}/notifications?limit=50`),
  markRead:(org:string,id:string)=>api(`${base(org)}/notifications/${id}/read`,{method:'PATCH'}),
  audit:(org:string)=>api<AuditEvent[]>(`${base(org)}/audit-events?limit=50`),
}
