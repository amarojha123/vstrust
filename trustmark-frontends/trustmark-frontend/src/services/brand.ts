import { api } from '@/api/client'

export type KnowledgeKind = 'guidelines' | 'approved-facts' | 'terminology-rules'
export type BrandProfile = { _id: string; name: string; voice?: string; tone?: string; audience?: string; description?: string; version: number }
export type KnowledgeItem = { _id: string; title?: string; statement?: string; term?: string; replacement?: string; description?: string; category?: string; severity?: string; sourceUrl?: string; status: string; version: number }
export type KnowledgeDocument={_id:string;filename:string;status:string;version:number;errorCode?:string}
const base = (org: string) => `/organizations/${org}`
export const brandService = {
  profile: (org: string) => api<BrandProfile | null>(`${base(org)}/brand-profile`),
  createProfile: (org: string, body: Record<string, string>) => api<BrandProfile>(`${base(org)}/brand-profile`, { method: 'POST', body }),
  updateProfile: (org: string, body: Record<string, string | number>) => api<BrandProfile>(`${base(org)}/brand-profile`, { method: 'PUT', body }),
  list: (org: string, kind: KnowledgeKind) => api<KnowledgeItem[]>(`${base(org)}/${kind}`),
  create: (org: string, kind: KnowledgeKind, body: Record<string, string | boolean>) => api<KnowledgeItem>(`${base(org)}/${kind}`, { method: 'POST', body }),
  publish: (org: string, kind: KnowledgeKind, item: KnowledgeItem) => api<KnowledgeItem>(`${base(org)}/${kind}/${item._id}/publish`, { method: 'POST', body: { version: item.version } }),
  documents:(org:string)=>api<KnowledgeDocument[]>(`${base(org)}/documents`),
  upload:(org:string,file:File)=>{const body=new FormData();body.append('file',file);return api<KnowledgeDocument>(`${base(org)}/documents`,{method:'POST',body})},
  publishDocument:(org:string,item:KnowledgeDocument)=>api<KnowledgeDocument>(`${base(org)}/documents/${item._id}/publish`,{method:'POST',body:{version:item.version}}),
  retryDocument:(org:string,item:KnowledgeDocument)=>api<KnowledgeDocument>(`${base(org)}/documents/${item._id}/retry`,{method:'POST',body:{version:item.version}}),
}
