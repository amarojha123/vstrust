import { createContext, useContext, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { authService } from '@/services/auth'
import { ApiError } from '@/api/client'
import type { User } from '@/types'
interface Ctx { user: User | null; loading: boolean; error: Error | null; setUser: (u: User | null) => void; logout: () => Promise<void> }
const AuthCtx = createContext<Ctx | null>(null)
export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['me'], queryFn: async () => {
    try { return await authService.me() } catch (e) { if (e instanceof ApiError && e.status === 401) return null; throw e }
  }, retry: false, refetchOnWindowFocus: query => query.state.data?.emailVerified === false ? 'always' : false })
  const setUser = (u: User | null) => qc.setQueryData(['me'], u)
  const logout = async () => { try { await authService.logout() } finally { qc.clear(); setUser(null) } }
  return <AuthCtx.Provider value={{ user: q.data ?? null, loading: q.isLoading, error: q.error, setUser, logout }}>{children}</AuthCtx.Provider>
}
export const useAuth = () => { const c = useContext(AuthCtx); if (!c) throw new Error('useAuth outside AuthProvider'); return c }
