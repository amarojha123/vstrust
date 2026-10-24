import { expect, test as base, type Page } from '@playwright/test'
import { resolve } from 'node:path'

const email = 'verification@example.test'
const organization = { _id: 'verification-org', name: 'Verification Brand Labs', slug: 'verification-brand-labs', role: 'admin' }
const resendButton = /resend.*verification|send.*verification/i
const refreshButton = /check.*verification|verified.*email|refresh.*verification/i

const test = base.extend<{ pageErrors: string[] }>({
  pageErrors: [async ({ page }, use) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await use(errors)
    expect(errors, 'verification must not throw uncaught browser errors').toEqual([])
  }, { auto: true }],
})

async function mockOnboarding(page: Page, verified = false) {
  const state = { verified, organizationCreated: false, organizationRequests: 0, submitted: undefined as unknown, meRequests: 0 }
  await page.route('https://fonts.googleapis.com/**', route => route.abort())
  await page.route('**/api/v1/auth/me', route => {
    state.meRequests++
    return route.fulfill({ json: { data: {
      id: 'verification-user', name: 'Verification Tester', email, emailVerified: state.verified,
      memberships: state.organizationCreated ? [{ organizationId: organization._id, role: 'admin' }] : [],
    } } })
  })
  await page.route('**/api/v1/organizations', async route => {
    if (route.request().method() === 'POST') {
      state.organizationRequests++
      state.submitted = route.request().postDataJSON()
      state.organizationCreated = true
      await route.fulfill({ status: 201, json: { data: organization } })
    } else {
      await route.fulfill({ json: { data: state.organizationCreated ? [organization] : [] } })
    }
  })
  await page.route('**/api/v1/organizations/*/analytics', route => route.fulfill({ json: { data: {
    submissions: 0, approvals: 0, rejections: 0, changesRequested: 0,
    findingsBySeverity: [], findingsByCategory: [], frequentlyViolatedRules: [], approvalRate: null,
    reviewTurnaround: { averageMs: null, sampleSize: 0 }, corrections: { accepted: 0, edited: 0, rejected: 0, rate: null },
  } } }))
  return state
}

async function fillOrganization(page: Page) {
  await page.getByLabel('Organization name').fill(organization.name)
  await page.getByLabel('URL slug').fill(organization.slug)
}

test('unverified onboarding explains verification and blocks organization submission', async ({ page }) => {
  const state = await mockOnboarding(page)
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Verify your email to continue', exact: true })).toBeVisible()
  await expect(page.getByText(email, { exact: false })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Open verification inbox', exact: true })).toHaveAttribute('href', 'http://localhost:8025')
  await expect(page.getByRole('button', { name: resendButton })).toBeVisible()
  await expect(page.getByRole('button', { name: refreshButton })).toBeVisible()
  await fillOrganization(page)
  await expect(page.getByRole('button', { name: 'Create organization', exact: true })).toBeDisabled()
  await page.getByLabel('URL slug').press('Enter')
  expect(state.organizationRequests).toBe(0)
})

test('resending verification uses the current account email and shows delivery guidance', async ({ page }) => {
  await mockOnboarding(page)
  let submitted: unknown
  await page.route('**/api/v1/auth/resend-verification', async route => {
    submitted = route.request().postDataJSON()
    await route.fulfill({ status: 202, json: { data: { message: 'If an unverified account exists, a verification email will be sent.' } } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: resendButton }).click()
  await expect(page.getByRole('status')).toContainText('Verification email requested. Open the latest message and follow its verification link.')
  expect(submitted).toEqual({ email })
  await expect(page.getByRole('button', { name: 'Create organization', exact: true })).toBeDisabled()
})

test('resend failures remain visible and allow a retry', async ({ page }) => {
  await mockOnboarding(page)
  let requests = 0
  await page.route('**/api/v1/auth/resend-verification', route => {
    requests++
    return route.fulfill({ status: 503, json: { error: { message: 'Email delivery is temporarily unavailable. Please try again.' } } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: resendButton }).click()
  await expect(page.getByRole('alert')).toContainText('Email delivery is temporarily unavailable. Please try again.')
  await expect(page.getByRole('button', { name: resendButton })).toBeEnabled()
  await page.getByRole('button', { name: resendButton }).click()
  await expect.poll(() => requests).toBe(2)
})

test('checking verification unlocks organization creation without losing entered values', async ({ page }) => {
  const state = await mockOnboarding(page)
  await page.goto('/')
  await fillOrganization(page)
  await page.getByRole('button', { name: refreshButton }).click()
  await expect.poll(() => state.meRequests).toBeGreaterThan(1)
  await expect(page.getByRole('status')).toContainText('Your email is not verified yet.')
  await expect(page.getByRole('button', { name: 'Create organization', exact: true })).toBeDisabled()

  state.verified = true
  await page.getByRole('button', { name: refreshButton }).click()
  await expect(page.getByRole('button', { name: 'Create organization', exact: true })).toBeEnabled()
  await expect(page.getByLabel('Organization name')).toHaveValue(organization.name)
  await expect(page.getByLabel('URL slug')).toHaveValue(organization.slug)
  await page.getByRole('button', { name: 'Create organization', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible()
  expect(state.submitted).toEqual({ name: organization.name, slug: organization.slug })
  expect(state.organizationRequests).toBe(1)
})

test('verified accounts can create an organization immediately', async ({ page }) => {
  const state = await mockOnboarding(page, true)
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Set up your organization', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Verify your email to continue', exact: true })).toHaveCount(0)
  await fillOrganization(page)
  await page.getByRole('button', { name: 'Create organization', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible()
  expect(state.organizationRequests).toBe(1)
})

test('verification instructions remain usable on a narrow mobile screen', async ({ page }) => {
  await mockOnboarding(page)
  await page.setViewportSize({ width: 320, height: 568 })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Verify your email to continue', exact: true })).toBeVisible()
  await page.getByRole('button', { name: refreshButton }).scrollIntoViewIfNeeded()
  await expect(page.getByRole('button', { name: refreshButton })).toBeInViewport()
  await expect(page.getByRole('button', { name: refreshButton })).toHaveCSS('color', 'rgb(23, 33, 29)')
  await expect(page.getByRole('button', { name: refreshButton })).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: resolve(process.cwd(), '../../.cache/verification-help-mobile.png'), fullPage: true })
})

test('verifying while signed in refreshes the cached account before continuing setup', async ({ page }) => {
  const state = await mockOnboarding(page)
  await page.route('**/api/v1/auth/verify-email', route => {
    state.verified = true
    return route.fulfill({ json: { data: { message: 'Email verified.' } } })
  })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Verify your email to continue', exact: true })).toBeVisible()
  // Keep the same React session cache, as when a verification route opens in-app.
  await page.evaluate(token => {
    window.history.pushState(null, '', `/verify-email?token=${token}`)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, 'a'.repeat(64))
  await expect(page.getByRole('heading', { name: 'Email verified', exact: true })).toBeVisible()
  await page.getByRole('link', { name: 'Continue to organization setup', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Set up your organization', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Verify your email to continue', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Create organization', exact: true })).toBeEnabled()
  expect(state.meRequests).toBeGreaterThan(1)
})

test('anonymous verification keeps the login continuation', async ({ page }) => {
  await page.route('https://fonts.googleapis.com/**', route => route.abort())
  await page.route('**/api/v1/auth/me', route => route.fulfill({ status: 401, json: { error: { message: 'Authentication required' } } }))
  await page.route('**/api/v1/auth/verify-email', route => route.fulfill({ json: { data: { message: 'Email verified.' } } }))
  await page.goto(`/verify-email?token=${'b'.repeat(64)}`)
  await expect(page.getByRole('heading', { name: 'Email verified', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Continue to login', exact: true })).toHaveAttribute('href', '/login')
})

test('an expired verification link returns signed-in users to setup and resend', async ({ page }) => {
  await mockOnboarding(page)
  await page.route('**/api/v1/auth/verify-email', route => route.fulfill({
    status: 400, json: { error: { message: 'The link is invalid or expired.' } },
  }))
  await page.goto(`/verify-email?token=${'c'.repeat(64)}`)
  await expect(page.getByRole('alert')).toContainText('The link is invalid or expired.')
  await page.getByRole('link', { name: 'Back to organization setup', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Verify your email to continue', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: resendButton })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Create organization', exact: true })).toBeDisabled()
})
