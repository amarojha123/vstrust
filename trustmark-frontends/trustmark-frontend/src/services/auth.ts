import { api } from '@/api/client'
import type { User } from '@/types'
import type { LoginInput, RegisterInput } from '@/schemas/auth'
type UserResponse = Omit<User, 'role' | 'organizationId'>
export const authService = {
  me: async (): Promise<User> => {
    const result = await api<UserResponse>('/auth/me')
    const membership = result.memberships[0]
    return { ...result, role: membership?.role ?? null, organizationId: membership?.organizationId ?? null }
  },
  login: async (b: LoginInput): Promise<User> => {
    await api('/auth/login', { method: 'POST', body: b })
    return authService.me()
  },
  register: (b: Omit<RegisterInput, 'confirmPassword'>) => api<{ user: Omit<User, 'role' | 'organizationId' | 'memberships'>; message: string }>('/auth/register', { method: 'POST', body: b }),
  verifyEmail: (token: string) => api<{ message: string }>('/auth/verify-email', { method: 'POST', body: { token } }),
  resendVerification: (email: string) => api<{ message: string }>('/auth/resend-verification', { method: 'POST', body: { email } }),
  logout: () => api<void>('/auth/logout', { method: 'POST' }),
}
