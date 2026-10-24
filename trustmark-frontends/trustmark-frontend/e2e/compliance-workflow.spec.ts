import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

type State = { organizationId: string; adminEmail: string; reviewerEmail: string; signupEmail: string; password: string }
const state = JSON.parse(await readFile(resolve(process.cwd(), '../../.cache/playwright-e2e-state.json'), 'utf8')) as State

test('registration reports verification and leaves the account session unauthenticated', async ({ page }) => {
  await page.goto('/register')
  await page.getByLabel('Full name').fill('E2E New Account')
  await page.getByLabel('Work email').fill(state.signupEmail)
  await page.getByLabel('Password', { exact: true }).fill(state.password)
  await page.getByLabel('Confirm password').fill(state.password)
  await expect(page.getByRole('button', { name: 'Create account' })).toHaveCSS('background-color', 'rgb(15, 107, 80)')
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByRole('status')).toContainText('Verify your email')
})

async function login(page: Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Work email').fill(email)
  await page.getByLabel('Password').fill(state.password)
  await page.getByRole('button', { name: 'Log in' }).click()
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
}

test('brand knowledge through scan corrections, submission, independent approval, analytics and audit', async ({ browser }) => {
  const flaggedTerm = `e2e${state.organizationId.slice(-6)}`
  const adminContext = await browser.newContext()
  const admin = await adminContext.newPage()
  await login(admin, state.adminEmail)

  await admin.getByRole('link', { name: 'Brand knowledge' }).click()
  await admin.getByLabel('Name', { exact: true }).fill('E2E Demo Brand')
  await admin.getByRole('button', { name: /^(Create|Update) profile$/ }).click()
  await expect(admin.getByRole('button', { name: 'Update profile' })).toBeVisible()
  await admin.getByRole('button', { name: 'Terminology' }).click()
  await admin.getByLabel('Term to flag').fill(flaggedTerm)
  await admin.getByLabel('Preferred replacement').fill('designed to')
  await admin.getByLabel('Description').fill('Avoid absolute performance claims')
  await admin.getByRole('button', { name: 'Add as draft' }).click()
  await admin.getByRole('button', { name: 'Publish' }).click()
  await expect(admin.getByText(/published/)).toBeVisible()

  await admin.getByRole('link', { name: 'Content' }).click()
  await admin.getByRole('button', { name: 'New document' }).click()
  await admin.getByLabel('Document title').fill('E2E campaign draft')
  await admin.getByLabel('Document text').fill(`Our product is ${flaggedTerm} to be the best choice.`)
  await admin.getByRole('button', { name: 'Create document' }).click()
  await admin.getByRole('button', { name: 'Run compliance scan' }).click()
  await expect(admin.getByText('Scan: completed')).toBeVisible({ timeout: 30_000 })
  await expect(admin.getByText('preferred_term')).toBeVisible()
  await expect(admin.locator('mark').first()).toContainText(flaggedTerm)
  await admin.locator('li').filter({ hasText: 'preferred_term' }).getByRole('button', { name: 'Use my edit' }).click()
  await expect(admin.getByText('These results belong to an older revision.')).toBeVisible()
  await admin.getByRole('button', { name: 'Run compliance scan' }).click()
  await expect(admin.getByText('Scan: completed')).toBeVisible({ timeout: 30_000 })
  await admin.getByRole('button', { name: 'Submit for review' }).click()

  const reviewerContext = await browser.newContext()
  const reviewer = await reviewerContext.newPage()
  await login(reviewer, state.reviewerEmail)
  await reviewer.getByRole('link', { name: 'Review queue' }).click()
  await reviewer.getByRole('button', { name: /E2E campaign draft/ }).click()
  await reviewer.getByLabel('Reviewer comment').fill('Reviewed the exact scanned revision.')
  await reviewer.getByRole('button', { name: 'Approve' }).click()
  await expect(reviewer.getByText('Nothing waiting for review')).toBeVisible()
  await reviewer.getByRole('link', { name: 'Notifications' }).click()
  await expect(reviewer.getByText('Content submitted for review')).toBeVisible()

  await admin.getByRole('link', { name: 'Analytics' }).click()
  await expect(admin.getByRole('heading', { name: 'Analytics' })).toBeVisible()
  await admin.getByRole('link', { name: 'Settings' }).click()
  await expect(admin.getByText('approval.decided')).toBeVisible()

  await reviewerContext.close()
  await adminContext.close()
})
