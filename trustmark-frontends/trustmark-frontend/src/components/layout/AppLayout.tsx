import { useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { BarChart3, Bell, BookOpen, ClipboardCheck, FileText, LayoutDashboard, LogOut, Menu, Moon, Settings, Sun, type LucideIcon } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import type { Role } from '@/types'
const nav: { to: string; label: string; icon: LucideIcon; roles?: Role[] }[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard }, { to: '/content', label: 'Content', icon: FileText },
  { to: '/brands', label: 'Brand knowledge', icon: BookOpen, roles: ['admin'] },
  { to: '/reviews', label: 'Review queue', icon: ClipboardCheck, roles: ['admin', 'reviewer'] },
  { to: '/analytics', label: 'Analytics', icon: BarChart3 }, { to: '/notifications', label: 'Notifications', icon: Bell }, { to: '/settings', label: 'Settings', icon: Settings, roles: ['admin'] }]
export default function AppLayout() {
  const { user, logout } = useAuth(); const [open, setOpen] = useState(false)
  const [dark, setDark] = useState(() => document.documentElement.dataset.theme === 'dark')
  const toggle = () => { const n = !dark; setDark(n); document.documentElement.dataset.theme = n ? 'dark' : 'light' }
  return <div className="min-h-screen md:grid md:grid-cols-[15rem_1fr]">
    <aside className={`${open ? 'block' : 'hidden'} border-r border-line bg-surface p-4 md:block`} aria-label="Primary">
      <p className="mb-6 font-display text-xl font-semibold text-seal">Trust Mark</p>
      <nav className="space-y-1">{nav.filter(n => !n.roles || (user?.role && n.roles.includes(user.role))).map(n =>
        <NavLink key={n.to} to={n.to} end={n.to === '/'} onClick={() => setOpen(false)}
          className={({ isActive }) => `flex items-center gap-2 rounded-md px-3 py-2 text-sm ${isActive ? 'bg-seal/10 font-medium text-seal' : 'text-muted hover:text-ink'}`}>
          <n.icon className="h-4 w-4" aria-hidden />{n.label}</NavLink>)}</nav></aside>
    <div className="flex min-w-0 flex-col">
      <header className="flex items-center justify-between border-b border-line bg-surface px-4 py-3">
        <button className="md:hidden" aria-label="Toggle menu" onClick={() => setOpen(!open)}><Menu /></button>
        <span className="text-sm text-muted">{user?.name}{user?.role ? `, ${user.role}` : ''}</span>
        <div className="flex gap-3"><button aria-label="Toggle theme" onClick={toggle}>{dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}</button>
          <button aria-label="Log out" onClick={logout}><LogOut className="h-4 w-4" /></button></div></header>
      <main className="p-4 md:p-8"><Outlet /></main></div></div>
}
