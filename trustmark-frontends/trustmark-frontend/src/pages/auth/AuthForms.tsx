import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation } from '@tanstack/react-query'
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { loginSchema, registerSchema, type LoginInput, type RegisterInput } from '@/schemas/auth'
import { authService } from '@/services/auth'
import { useAuth } from '@/contexts/AuthContext'
import VerificationInboxLink from '@/components/auth/VerificationInboxLink'
import { Button, Field, inputCls } from '@/components/ui'
function Shell({ title, children, foot }: { title: string; children: React.ReactNode; foot: React.ReactNode }) {
  return <main className="flex min-h-dvh items-center justify-center p-4 sm:p-6"><div className="min-w-0 w-full max-w-sm rounded-lg border border-line bg-surface p-5 sm:p-6">
    <h1 className="mb-1 text-2xl font-semibold">{title}</h1><p className="mb-5 text-sm text-muted">Trust Mark brand governance</p>{children}<p className="mt-4 text-sm text-muted">{foot}</p></div></main>
}
export function LoginPage() {
  const { user, setUser } = useAuth(); const nav = useNavigate(); const location = useLocation(); const from = (location.state as { from?: string } | null)?.from ?? '/'
  const f = useForm<LoginInput>({ resolver: zodResolver(loginSchema) })
  const m = useMutation({ mutationFn: authService.login, onSuccess: u => { setUser(u); nav(from, { replace: true }) } })
  if (user) return <Navigate to="/" replace />
  return <Shell title="Log in" foot={<>New here? <Link className="text-seal underline" to="/register">Create an account</Link></>}>
    {(location.state as { registered?: boolean } | null)?.registered && <div className="mb-4 space-y-2 rounded-md border border-seal/30 bg-seal/5 p-3 text-sm" role="status"><p>Account created. Verify your email using the link in your inbox, then log in to continue.</p><VerificationInboxLink /></div>}
    <form onSubmit={f.handleSubmit(v => { if (!m.isPending) m.mutate(v) })} className="space-y-4" aria-busy={m.isPending} noValidate>
      <Field label="Work email" error={f.formState.errors.email?.message}><input type="email" autoComplete="email" className={inputCls} {...f.register('email')} /></Field>
      <Field label="Password" error={f.formState.errors.password?.message}><input type="password" autoComplete="current-password" className={inputCls} {...f.register('password')} /></Field>
      {m.error && <p role="alert" className="text-sm text-sev-critical">{m.error.message}</p>}
      <Button type="submit" loading={m.isPending} className="w-full">{m.isPending ? 'Logging in…' : 'Log in'}</Button></form></Shell>
}
export function RegisterPage() {
  const nav = useNavigate()
  const f = useForm<RegisterInput>({ resolver: zodResolver(registerSchema) })
  const m = useMutation({ mutationFn: authService.register, onSuccess: () => nav('/login', { replace: true, state: { registered: true } }) })
  const e = f.formState.errors
  return <Shell title="Create your account" foot={<>Have an account? <Link className="text-seal underline" to="/login">Log in</Link></>}>
    <form onSubmit={f.handleSubmit(({ confirmPassword: _c, ...v }) => { if (!m.isPending) m.mutate(v) })} className="space-y-4" aria-busy={m.isPending} noValidate>
      <Field label="Full name" error={e.name?.message}><input autoComplete="name" className={inputCls} {...f.register('name')} /></Field>
      <Field label="Work email" error={e.email?.message}><input type="email" autoComplete="email" className={inputCls} {...f.register('email')} /></Field>
      <Field label="Password" hint="Use 12–128 characters." error={e.password?.message}><input type="password" autoComplete="new-password" className={inputCls} {...f.register('password')} /></Field>
      <Field label="Confirm password" error={e.confirmPassword?.message}><input type="password" autoComplete="new-password" className={inputCls} {...f.register('confirmPassword')} /></Field>
      {m.error && <p role="alert" className="text-sm text-sev-critical">{m.error.message}</p>}
      <Button type="submit" loading={m.isPending} className="w-full">{m.isPending ? 'Creating account…' : 'Create account'}</Button></form></Shell>
}
