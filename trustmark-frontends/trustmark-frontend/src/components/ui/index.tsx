import { cloneElement, useId, type ButtonHTMLAttributes, type ReactElement, type ReactNode } from 'react'
import { AlertTriangle, Inbox, Loader2 } from 'lucide-react'
import type { Severity } from '@/types'
export function Button({ loading, variant = 'primary', className = '', children, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean; variant?: 'primary' | 'secondary' }) {
  const colors = variant === 'secondary' ? 'border border-line bg-surface text-ink' : 'bg-seal text-white'
  return <button {...p} disabled={p.disabled || loading} aria-busy={loading || undefined} className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-seal disabled:opacity-50 ${colors} ${className}`}>
    {loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}{children}</button>
}
export const Spinner = ({ label = 'Loading' }: { label?: string }) =>
  <div role="status" className="flex items-center gap-2 p-8 text-muted"><Loader2 className="h-5 w-5 animate-spin" aria-hidden />{label}…</div>
export const ErrorState = ({ message, onRetry }: { message: string; onRetry?: () => void }) =>
  <div role="alert" className="m-4 flex flex-col items-start gap-3 rounded-md border border-sev-critical/40 p-5">
    <p className="flex items-center gap-2 font-medium text-sev-critical"><AlertTriangle className="h-4 w-4" aria-hidden />{message}</p>
    {onRetry && <Button onClick={onRetry}>Try again</Button>}</div>
export const EmptyState = ({ title, hint }: { title: string; hint?: ReactNode }) =>
  <div className="flex flex-col items-center gap-2 p-10 text-center"><Inbox className="h-6 w-6 text-muted" aria-hidden /><p className="font-medium">{title}</p>{hint && <p className="max-w-sm text-sm text-muted">{hint}</p>}</div>
const sevCls: Record<Severity, string> = { critical: 'text-sev-critical', high: 'text-sev-high', medium: 'text-sev-medium', low: 'text-sev-low', info: 'text-muted' }
// Severity is always a text label, never colour alone.
export const SeverityBadge = ({ s }: { s: Severity }) => <span className={`rounded border border-current px-1.5 py-0.5 text-xs font-medium ${sevCls[s]}`}>{s[0].toUpperCase() + s.slice(1)}</span>
export function Field({ label, error, hint, children }: {
  label: string; error?: string; hint?: string;
  children: ReactElement<{ id?: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }>
}) {
  const generatedId = useId()
  const id = children.props.id ?? generatedId
  const describedBy = [children.props['aria-describedby'], hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ') || undefined
  return <div className="min-w-0 text-sm">
    <label htmlFor={id} className="mb-1 block font-medium">{label}</label>
    {cloneElement(children, { id, 'aria-invalid': !!error, 'aria-describedby': describedBy })}
    {hint && <p id={`${id}-hint`} className="mt-1 text-muted">{hint}</p>}
    {error && <p id={`${id}-error`} role="alert" className="mt-1 text-sev-critical">{error}</p>}
  </div>
}
export const inputCls = 'min-h-11 min-w-0 w-full rounded-md border border-line bg-surface px-3 py-2 text-base focus:border-seal focus:outline-none focus:ring-2 focus:ring-seal/25 sm:text-sm'
