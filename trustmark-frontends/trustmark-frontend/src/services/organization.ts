import { api } from '@/api/client'
import type { Role } from '@/types'
const base=(org:string)=>`/organizations/${org}`
export type Member={_id:string;role:Role;userId:{_id:string;name:string;email:string}}
export type Invitation={_id:string;email:string;role:Role;expiresAt:string}
export const organizationService={
  details:(org:string)=>api<{_id:string;name:string;slug:string}>(base(org)),
  members:(org:string)=>api<Member[]>(`${base(org)}/members`),
  invitations:(org:string)=>api<Invitation[]>(`${base(org)}/invitations`),
  invite:(org:string,email:string,role:Role)=>api(`${base(org)}/invitations`,{method:'POST',body:{email,role}}),
  setRole:(org:string,id:string,role:Role)=>api(`${base(org)}/members/${id}/role`,{method:'PATCH',body:{role}}),
  remove:(org:string,id:string)=>api<void>(`${base(org)}/members/${id}`,{method:'DELETE'}),
}
