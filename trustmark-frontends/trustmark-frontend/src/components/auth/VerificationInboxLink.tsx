export default function VerificationInboxLink() {
  if (!import.meta.env.DEV || !['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)) return null
  return <p className="text-sm">For local testing, your email is available here: <a className="text-seal underline" href="http://localhost:8025" target="_blank" rel="noreferrer">Open verification inbox</a>.</p>
}
