import { expect, test as base, type Page } from '@playwright/test'
import { resolve } from 'node:path'
import type { DashboardMetrics } from '../src/types'
import type { ContentItem, FindingItem, ScanItem } from '../src/services/content'

const organization = { _id: 'dashboard-active-org', name: 'Dashboard Test Workspace', slug: 'dashboard-test-workspace', role: 'admin' }
const otherOrganization = { _id: 'dashboard-other-org', name: 'Other Workspace', slug: 'other-workspace', role: 'admin' }
const userId = 'dashboard-test-user'
const emptyMetrics = (): DashboardMetrics => ({
  submissions: 0, approvals: 0, rejections: 0, changesRequested: 0,
  findingsBySeverity: [], findingsByCategory: [], frequentlyViolatedRules: [], approvalRate: null,
  reviewTurnaround: { averageMs: null, sampleSize: 0 },
  corrections: { accepted: 0, edited: 0, rejected: 0, rate: null },
})

const test = base.extend<{ pageErrors: string[] }>({
  pageErrors: [async ({ page }, use) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await use(errors)
    expect(errors, 'dashboard must not throw uncaught browser errors').toEqual([])
  }, { auto: true }],
})

async function mockDashboard(page: Page, multipleOrganizations = false) {
  const state = {
    metrics: emptyMetrics(),
    fail: false,
    requests: [] as string[],
  }
  await page.route('https://fonts.googleapis.com/**', route => route.abort())
  await page.route('**/api/v1/auth/me', route => route.fulfill({ json: { data: {
    id: userId, name: 'Dashboard Tester', email: 'dashboard@example.test', emailVerified: true,
    memberships: [{ organizationId: organization._id, role: 'admin' }, ...(multipleOrganizations ? [{ organizationId: otherOrganization._id, role: 'admin' }] : [])],
  } } }))
  await page.route('**/api/v1/organizations', route => route.fulfill({ json: {
    data: multipleOrganizations ? [otherOrganization, organization] : [organization],
  } }))
  await page.route('**/api/v1/organizations/*/analytics*', route => {
    const org = new URL(route.request().url()).pathname.split('/')[4]!
    state.requests.push(org)
    return route.fulfill(state.fail ? {
      status: 503, json: { error: { message: 'Analytics is temporarily unavailable.' } },
    } : { json: { data: org === organization._id ? state.metrics : { ...emptyMetrics(), submissions: 99 } } })
  })
  return state
}

function metric(page: Page, label: string) {
  return page.locator('dl > div').filter({ has: page.getByText(label, { exact: true }) }).locator('dd')
}

for (const path of ['/', '/analytics']) {
  test(`${path === '/' ? 'dashboard' : 'analytics'} refreshes persisted counters without leaving the page`, async ({ page }) => {
    const state = await mockDashboard(page)
    let navigations = 0
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++ })
    await page.goto(path)
    await expect(metric(page, 'Submissions')).toHaveText('0')
    const initialNavigations = navigations
    const initialRequests = state.requests.length
    state.metrics = {
      ...emptyMetrics(), submissions: 3, approvals: 1, changesRequested: 1, rejections: 1,
      findingsBySeverity: [{ severity: 'high', count: 2 }],
      findingsByCategory: [{ category: 'terminology', count: 2 }],
      frequentlyViolatedRules: [{ ruleType: 'preferred_term', count: 2 }],
    }
    await expect(metric(page, 'Submissions')).toHaveText('3', { timeout: 8_000 })
    await expect(metric(page, 'Approved')).toHaveText('1')
    await expect(metric(page, 'Changes requested')).toHaveText('1')
    expect(state.requests.length).toBeGreaterThan(initialRequests)
    expect(navigations).toBe(initialNavigations)
    await expect(page).toHaveURL(new RegExp(path === '/' ? '/$' : '/analytics$'))
  })
}

test('dashboard uses the active organization even when the organization list has another item first', async ({ page }) => {
  const state = await mockDashboard(page, true)
  state.metrics.submissions = 7
  await page.goto('/')
  await expect(metric(page, 'Submissions')).toHaveText('7')
  await expect(page.getByText(organization.name, { exact: true })).toBeVisible()
  expect(state.requests.length).toBeGreaterThan(0)
  expect(state.requests.every(org => org === organization._id)).toBe(true)
  await page.getByRole('link', { name: 'Analytics', exact: true }).click()
  await expect(metric(page, 'Submissions')).toHaveText('7')
})

test('Refresh requests fresh metrics immediately', async ({ page }) => {
  const state = await mockDashboard(page)
  await page.goto('/')
  await expect(metric(page, 'Submissions')).toHaveText('0')
  state.metrics.submissions = 4
  const previousRequests = state.requests.length
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(metric(page, 'Submissions')).toHaveText('4')
  expect(state.requests.length).toBeGreaterThan(previousRequests)
  await expect(page.getByText(/Updates every 5 seconds/)).toBeVisible()
})

test('a failed background refresh retains the last successful data and can recover', async ({ page }) => {
  const state = await mockDashboard(page)
  state.metrics.submissions = 2
  await page.goto('/')
  await expect(metric(page, 'Submissions')).toHaveText('2')
  state.fail = true
  await expect(page.getByRole('alert')).toContainText('Could not refresh dashboard data. Showing the last successful update.', { timeout: 10_000 })
  await expect(metric(page, 'Submissions')).toHaveText('2')
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible()
  state.fail = false
  state.metrics.submissions = 5
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(metric(page, 'Submissions')).toHaveText('5')
  await expect(page.getByRole('alert')).toHaveCount(0)
})

type DashboardState = Awaited<ReturnType<typeof mockDashboard>>
async function mockContent(page: Page, state: DashboardState, initialStatus: string = 'analyzed', initialScanStatus: ScanItem['status'] = 'completed') {
  const item: ContentItem = {
    _id: 'dashboard-document', title: 'Dashboard sample campaign', body: 'A guaranteed result.',
    status: initialStatus, version: 1, currentRevisionId: 'dashboard-revision', createdBy: 'independent-author',
  }
  const scan: ScanItem = { _id: 'dashboard-scan', revisionId: item.currentRevisionId, status: initialScanStatus, createdAt: '2026-10-25T00:00:00.000Z' }
  const finding: FindingItem = { _id: 'dashboard-finding', category: 'terminology', severity: 'high', message: 'Avoid absolute guarantees.', suggestion: 'A designed result.', status: 'open', version: 0, evidence: [] }
  const contentState = { item, scan, finding, submitRequests: 0, reviewRequests: 0, correctionRequests: 0 }
  await page.route(`**/api/v1/organizations/${organization._id}/content**`, async route => {
    const url = new URL(route.request().url())
    const method = route.request().method()
    const endpoint = url.pathname.split('/').slice(5).join('/')
    if (endpoint === 'content') {
      const status = url.searchParams.get('status')
      return route.fulfill({ json: { data: !status || status === item.status ? [item] : [] } })
    }
    if (endpoint.endsWith('/revisions')) return route.fulfill({ json: { data: [{ _id: item.currentRevisionId, title: item.title, body: item.body, number: 1, createdAt: scan.createdAt }] } })
    if (endpoint.endsWith('/scans')) return route.fulfill({ json: { data: [scan] } })
    if (endpoint.endsWith('/submit') && method === 'POST') {
      contentState.submitRequests++
      item.status = 'in_review'
      item.version++
      state.metrics.submissions++
      return route.fulfill({ json: { data: item } })
    }
    if (endpoint.endsWith('/review') && method === 'POST') {
      contentState.reviewRequests++
      item.status = 'approved'
      item.version++
      state.metrics.approvals++
      state.metrics.approvalRate = 1
      return route.fulfill({ json: { data: item } })
    }
    return route.fulfill({ json: { data: item } })
  })
  await page.route(`**/api/v1/organizations/${organization._id}/scans/*/findings`, route => route.fulfill({ json: { data: [finding] } }))
  await page.route(`**/api/v1/organizations/${organization._id}/findings/*/decisions`, route => {
    contentState.correctionRequests++
    finding.status = 'accepted'
    item.version++
    item.currentRevisionId = 'corrected-revision'
    item.body = finding.suggestion!
    state.metrics.corrections = { accepted: 1, edited: 0, rejected: 0, rate: 1 }
    return route.fulfill({ json: { data: finding } })
  })
  return contentState
}

test('submitting a document updates cached dashboard counters on return', async ({ page }) => {
  const state = await mockDashboard(page)
  const content = await mockContent(page, state)
  await page.goto('/')
  await expect(metric(page, 'Submissions')).toHaveText('0')
  await page.getByRole('link', { name: 'Content', exact: true }).click()
  await page.getByRole('button', { name: 'Submit for review', exact: true }).click()
  await expect.poll(() => content.submitRequests).toBe(1)
  await page.getByRole('link', { name: 'Dashboard', exact: true }).click()
  await expect(metric(page, 'Submissions')).toHaveText('1')
})

test('a review decision updates analytics in the same browser session', async ({ page }) => {
  const state = await mockDashboard(page)
  state.metrics.submissions = 1
  const content = await mockContent(page, state, 'in_review')
  await page.goto('/analytics')
  await expect(metric(page, 'Approved')).toHaveText('0')
  await page.getByRole('link', { name: 'Review queue', exact: true }).click()
  await page.getByRole('button', { name: new RegExp(content.item.title) }).click()
  await page.getByLabel('Reviewer comment').fill('Reviewed the saved campaign revision.')
  await page.getByRole('button', { name: 'Approve', exact: true }).click()
  await expect.poll(() => content.reviewRequests).toBe(1)
  await page.getByRole('link', { name: 'Analytics', exact: true }).click()
  await expect(metric(page, 'Approved')).toHaveText('1')
  await expect(metric(page, 'Approval rate')).toHaveText('100%')
})

test('completed scans update finding totals when returning to the dashboard', async ({ page }) => {
  const state = await mockDashboard(page)
  const content = await mockContent(page, state, 'draft', 'running')
  await page.goto('/')
  await expect(page.getByText('No violations yet', { exact: true })).toBeVisible()
  await page.getByRole('link', { name: 'Content', exact: true }).click()
  await expect(page.getByText('Scan: running', { exact: true })).toBeVisible()
  content.scan.status = 'completed'
  content.item.status = 'analyzed'
  state.metrics.findingsBySeverity = [{ severity: 'high', count: 1 }]
  state.metrics.frequentlyViolatedRules = [{ ruleType: 'preferred_term', count: 1 }]
  await expect(page.getByText('Scan: completed', { exact: true })).toBeVisible()
  await page.getByRole('link', { name: 'Dashboard', exact: true }).click()
  await expect(page.getByText('preferred_term', { exact: true })).toBeVisible()
  await expect(page.getByText('No violations yet', { exact: true })).toHaveCount(0)
})

test('correction decisions update analytics without a hard reload', async ({ page }) => {
  const state = await mockDashboard(page)
  const content = await mockContent(page, state)
  await page.goto('/analytics')
  await expect(metric(page, 'Correction rate')).toHaveText('—')
  await page.getByRole('link', { name: 'Content', exact: true }).click()
  await page.getByRole('button', { name: 'Accept suggestion', exact: true }).click()
  await expect.poll(() => content.correctionRequests).toBe(1)
  await page.getByRole('link', { name: 'Analytics', exact: true }).click()
  await expect(metric(page, 'Correction rate')).toHaveText('100%')
})

test('live dashboard controls and cards fit a mobile screen', async ({ page }) => {
  await mockDashboard(page)
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto('/')
  await expect(metric(page, 'Submissions')).toHaveText('0')
  const refresh = page.getByRole('button', { name: 'Refresh', exact: true })
  await expect(refresh).toBeVisible()
  await expect(refresh).toHaveCSS('color', 'rgb(23, 33, 29)')
  await expect(refresh).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: resolve(process.cwd(), '../../.cache/dashboard-live-mobile.png'), fullPage: true })
})
