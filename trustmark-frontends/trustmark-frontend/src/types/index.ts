export type Role = 'admin' | 'creator' | 'reviewer' | 'auditor'
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info'
export interface Membership { organizationId: string; role: Role }
export interface User { id: string; name: string; email: string; emailVerified: boolean; memberships: Membership[]; role: Role | null; organizationId: string | null }
export interface Organization { _id: string; name: string; slug: string; role: Role }
export interface DashboardMetrics {
  submissions: number; approvals: number; rejections: number; changesRequested: number
  findingsBySeverity: { severity: Severity; count: number }[]
  findingsByCategory: { category: string; count: number }[]
  frequentlyViolatedRules: { ruleId?: string; ruleType?: string; count: number }[]
  approvalRate: number | null
  reviewTurnaround: { averageMs: number | null; sampleSize: number }
  corrections: { accepted: number; edited: number; rejected: number; rate: number | null }
}
