// In local development Vite proxies /api to Express; in production the web
// container can serve the same-origin reverse proxy or set an explicit URL.
export const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '/api/v1'
export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: unknown) { super(message) }
}
function csrfToken(): string | undefined {
  if (typeof document === 'undefined') return undefined
  const cookie = document.cookie.split(';').map(value => value.trim()).find(value => value.startsWith('tm_csrf='))
  return cookie ? decodeURIComponent(cookie.slice('tm_csrf='.length)) : undefined
}
export async function api<T>(path: string, init: Omit<RequestInit, 'body'> & { body?: unknown } = {}): Promise<T> {
  let res: Response
  const method = (init.method ?? 'GET').toUpperCase()
  const csrf = !['GET', 'HEAD', 'OPTIONS'].includes(method) ? csrfToken() : undefined
  const multipart = typeof FormData !== 'undefined' && init.body instanceof FormData
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init, credentials: 'include', // session lives in an httpOnly cookie set by the backend
      headers: { ...(!multipart ? { 'Content-Type': 'application/json' } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...init.headers },
      body: init.body === undefined ? undefined : multipart ? init.body as FormData : JSON.stringify(init.body),
    })
  } catch { throw new ApiError(0, 'Cannot reach the server. Check your connection and try again.') }
  if (res.status === 204) return undefined as T
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new ApiError(res.status, data?.error?.message ?? data?.message ?? `Request failed (${res.status})`, data)
  return (data?.data ?? data) as T
}
