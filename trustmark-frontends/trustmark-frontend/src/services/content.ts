import { api } from '@/api/client'

export type ContentItem = { _id: string; title: string; body: string; status: string; version: number; currentRevisionId: string; latestScanId?: string; createdBy: string }
export type ScanItem = { _id: string; revisionId: string; status: 'queued' | 'running' | 'completed' | 'failed'; createdAt: string }
export type FindingItem = { _id: string; category: string; severity: 'info' | 'low' | 'medium' | 'high' | 'critical'; message: string; suggestion?: string; start?: number; end?: number; status: string; version: number; evidence: { quote: string; sourceId: string; chunkId?: string }[] }
export type RevisionItem={_id:string;number:number;title:string;body:string;createdAt:string}

const orgPath = (organizationId: string) => `/organizations/${organizationId}`
export const contentService = {
  list: (org: string, status?: string) => api<ContentItem[]>(`${orgPath(org)}/content${status ? `?status=${status}` : ''}`),
  get: (org: string, id: string) => api<ContentItem>(`${orgPath(org)}/content/${id}`),
  revisions:(org:string,id:string)=>api<RevisionItem[]>(`${orgPath(org)}/content/${id}/revisions`),
  revision:(org:string,id:string,revisionId:string)=>api<RevisionItem>(`${orgPath(org)}/content/${id}/revisions/${revisionId}`),
  compare:(org:string,id:string,from:string,to:string)=>api<{from:RevisionItem;to:RevisionItem;titleChanged:boolean;change:{start:number;removed:string;added:string}}>(`${orgPath(org)}/content/${id}/revisions/compare?from=${from}&to=${to}`),
  create: (org: string, body: { title: string; body: string }) => api<ContentItem>(`${orgPath(org)}/content`, { method: 'POST', body }),
  save: (org: string, item: ContentItem, body: { title: string; body: string }) => api<ContentItem>(`${orgPath(org)}/content/${item._id}/autosave`, { method: 'PUT', body: { ...body, version: item.version } }),
  submit: (org: string, item: ContentItem) => api(`${orgPath(org)}/content/${item._id}/submit`, { method: 'POST', body: { version: item.version } }),
  review: (org: string, item: ContentItem, decision: 'approved' | 'rejected' | 'changes_requested', comment: string) => api(`${orgPath(org)}/content/${item._id}/review`, { method: 'POST', body: { version: item.version, decision, comment } }),
  scans: (org: string, contentId: string) => api<ScanItem[]>(`${orgPath(org)}/content/${contentId}/scans`),
  scan: (org: string, contentId: string, version: number) => api<ScanItem>(`${orgPath(org)}/content/${contentId}/scans`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: { version } }),
  findings: (org: string, scanId: string) => api<FindingItem[]>(`${orgPath(org)}/scans/${scanId}/findings`),
  decide: (org: string, finding: FindingItem, content: ContentItem, decision: 'accepted' | 'edited' | 'rejected', replacement?: string) => api(`${orgPath(org)}/findings/${finding._id}/decisions`, { method: 'POST', body: { version: content.version, findingVersion: finding.version, decision, ...(decision==='edited'?{replacement}:{}), reason: decision === 'accepted' ? 'Accepted suggested correction' : decision === 'edited' ? 'Edited suggested correction' : 'Creator rejected suggestion' } }),
}
