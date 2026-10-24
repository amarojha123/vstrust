import { createBrowserRouter } from 'react-router-dom'
import ProtectedRoute from './ProtectedRoute'
import AppLayout from '@/components/layout/AppLayout'
import { LoginPage, RegisterPage } from '@/pages/auth/AuthForms'
import VerifyEmailPage from '@/pages/auth/VerifyEmailPage'
import DashboardPage from '@/pages/dashboard/DashboardPage'
import ContentPage from '@/pages/content/ContentPage'
import AnalyticsPage from '@/pages/analytics/AnalyticsPage'
import BrandPage from '@/pages/brands/BrandPage'
import ReviewPage from '@/pages/reviews/ReviewPage'
import SettingsPage from '@/pages/settings/SettingsPage'
import NotificationsPage from '@/pages/notifications/NotificationsPage'
export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> }, { path: '/register', element: <RegisterPage /> }, { path: '/verify-email', element: <VerifyEmailPage /> },
  { element: <ProtectedRoute />, children: [{ element: <AppLayout />, children: [
    { index: true, element: <DashboardPage /> },
    { path: 'content', element: <ContentPage /> }, { path: 'analytics', element: <AnalyticsPage /> }, { path: 'notifications', element: <NotificationsPage /> },
    { element: <ProtectedRoute roles={['admin']} />, children: [{ path: 'brands', element: <BrandPage /> }] },
    { element: <ProtectedRoute roles={['admin', 'reviewer']} />, children: [{ path: 'reviews', element: <ReviewPage /> }] },
    { element: <ProtectedRoute roles={['admin']} />, children: [{ path: 'settings', element: <SettingsPage /> }] },
  ] }] }])
