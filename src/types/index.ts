export const roles = ['admin', 'creator', 'reviewer', 'auditor'] as const;
export type Role = typeof roles[number];
export const severities = ['info', 'low', 'medium', 'high', 'critical'] as const;
export const contentStates = ['draft', 'analyzed', 'in_review', 'changes_requested', 'resubmitted', 'approved', 'rejected'] as const;
export type ContentState = typeof contentStates[number];
export interface Actor {
  userId: string;
  organizationId: string;
  role: Role;
  correlationId: string;
}
export type Permission = 'organization:read' | 'member:write' | 'brand:read' | 'brand:write' | 'document:read' | 'document:write' | 'content:read' | 'content:write' | 'scan:write' | 'review:write' | 'analytics:read' | 'audit:read' | 'evaluation:write' | 'export:read';
declare global {
  namespace Express {
    interface Request {
      auth?: { userId: string; sessionId: string };
      tenant?: { organizationId: string; role: Role };
      correlationId: string;
    }
  }
}
