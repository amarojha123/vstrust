import { api } from '@/api/client'
import type { DashboardMetrics, Organization } from '@/types'
export const dashboardService = {
  organizations: () => api<Organization[]>('/organizations'),
  createOrganization: (body: { name: string; slug: string }) => api<Organization>('/organizations', { method: 'POST', body }),
  metrics: (organizationId: string) => api<DashboardMetrics>(`/organizations/${organizationId}/analytics`),
}
