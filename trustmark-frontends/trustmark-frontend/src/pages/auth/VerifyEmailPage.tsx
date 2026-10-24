import { useEffect, useRef } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { authService } from '@/services/auth'
import { useAuth } from '@/contexts/AuthContext'
import { ErrorState, Spinner } from '@/components/ui'

export default function VerifyEmailPage() {
  const [params] = useSearchParams()
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const token = params.get('token') ?? ''
  const verify = useMutation({ mutationFn: authService.verifyEmail, onSuccess: () => queryClient.invalidateQueries({ queryKey: ['me'] }) })
  const { mutate } = verify
  const started = useRef<string | null>(null)
  useEffect(() => { if (/^[a-f0-9]{64}$/.test(token) && started.current !== token) { started.current = token; mutate(token) } }, [token, mutate])
  const back = <Link className="text-seal underline" to={user ? '/' : '/login'}>{user ? 'Back to organization setup' : 'Back to login'}</Link>
  if (!/^[a-f0-9]{64}$/.test(token)) return <main className="mx-auto max-w-lg space-y-4 p-6"><ErrorState message="This verification link is invalid. Request a new verification email from organization setup." />{back}</main>
  if (verify.isPending || verify.isIdle) return <Spinner label="Verifying your email" />
  if (verify.isError) return <main className="mx-auto max-w-lg space-y-4 p-6"><ErrorState message={`${verify.error.message} Request a new verification email from organization setup.`} />{back}</main>
  return <main className="mx-auto mt-12 max-w-lg space-y-4 p-6 text-center"><h1 className="text-2xl font-semibold">Email verified</h1><p>{verify.data.message}</p><Link className="text-seal underline" to={user ? '/' : '/login'}>{user ? 'Continue to organization setup' : 'Continue to login'}</Link></main>
}
