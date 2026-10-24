import { useMutation } from '@tanstack/react-query'
import { useAuth } from '@/contexts/AuthContext'
import { authService } from '@/services/auth'
import { Button } from '@/components/ui'
import VerificationInboxLink from './VerificationInboxLink'

export default function EmailVerificationNotice() {
  const { user, setUser } = useAuth()
  const resend = useMutation({ mutationFn: () => authService.resendVerification(user!.email) })
  const check = useMutation({ mutationFn: authService.me, onSuccess: setUser })

  if (!user || user.emailVerified) return null

  return <section aria-labelledby="email-verification-title" className="space-y-3 rounded-lg border border-seal/30 bg-surface p-4">
    <h2 id="email-verification-title" className="font-semibold">Verify your email to continue</h2>
    <p className="text-sm text-muted">Verify <strong className="break-all text-ink">{user.email}</strong> before creating your organization. Your organization details will stay here while you verify.</p>
    <ol className="list-decimal space-y-1 pl-5 text-sm">
      <li>Open the latest verification email.</li>
      <li>Follow the verification link in the message.</li>
      <li>Return here and choose Check verification status.</li>
    </ol>
    <VerificationInboxLink />
    <div className="flex flex-wrap gap-2">
      <Button type="button" loading={resend.isPending} disabled={check.isPending} onClick={() => { if (!resend.isPending) { check.reset(); resend.mutate() } }}>{resend.isPending ? 'Sending verification email…' : 'Resend verification email'}</Button>
      <Button type="button" variant="secondary" loading={check.isPending} disabled={resend.isPending} onClick={() => { if (!check.isPending) { resend.reset(); check.mutate() } }}>{check.isPending ? 'Checking verification…' : 'Check verification status'}</Button>
    </div>
    {resend.isSuccess && <p role="status" className="text-sm text-seal">Verification email requested. Open the latest message and follow its verification link.</p>}
    {check.isSuccess && !check.data.emailVerified && <p role="status" className="text-sm text-muted">Your email is not verified yet. Open the verification link, then check again.</p>}
    {(resend.error || check.error) && <p role="alert" className="text-sm text-sev-critical">{(resend.error || check.error)!.message}</p>}
  </section>
}
