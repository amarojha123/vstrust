import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import { ErrorState, Spinner } from '@/components/ui'
import type { Role } from '@/types'
// UX gating only. The backend must enforce every permission.
export default function ProtectedRoute({ roles }: { roles?: Role[] }) {
  const { user, loading, error } = useAuth(); const loc = useLocation()
  if (loading) return <Spinner label="Checking your session" />
  if (error) return <ErrorState message={error.message} onRetry={() => location.reload()} />
  if (!user) return <Navigate to="/login" state={{ from: loc.pathname }} replace />
  if (roles && (!user.role || !roles.includes(user.role))) return <ErrorState message="Your role does not have access to this page." />
  return <Outlet />
}
