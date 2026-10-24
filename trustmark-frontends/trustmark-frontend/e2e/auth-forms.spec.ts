import { expect, test as base, type Page } from '@playwright/test'

const password = 'Trustmark-Password-123!'
const test = base.extend<{ pageErrors: string[] }>({
  pageErrors: [async ({ page }, use) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await use(errors)
    expect(errors, 'forms must not throw uncaught validation errors').toEqual([])
  }, { auto: true }],
})

test.beforeEach(async ({ page }) => {
  await page.route('https://fonts.googleapis.com/**', route => route.abort())
  await page.route('**/api/v1/auth/me', route => route.fulfill({
    status: 401,
    json: { error: { message: 'Authentication required' } },
  }))
})

async function fillRegistration(page: Page, value = password) {
  await page.getByLabel('Full name').fill('Signup Tester')
  await page.getByLabel('Work email').fill('signup@example.test')
  await page.getByLabel('Password', { exact: true }).fill(value)
  await page.getByLabel('Confirm password').fill(value)
}

for (const invalidPassword of ['1234', '1234567890']) {
  test(`a ${invalidPassword.length}-character password gives feedback without calling signup`, async ({ page }) => {
    let requests = 0
    await page.route('**/api/v1/auth/register', async route => {
      requests++
      await route.fulfill({ status: 500, json: {} })
    })
    await page.goto('/register')
    await fillRegistration(page, invalidPassword)
    await page.getByRole('button', { name: 'Create account' }).click()
    await expect(page.getByRole('alert')).toContainText('Use at least 12 characters')
    await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('aria-invalid', 'true')
    await expect(page.getByLabel('Password', { exact: true })).toHaveAccessibleDescription(/Use at least 12 characters/)
    await expect(page.getByRole('button', { name: 'Create account' })).toBeEnabled()
    expect(requests).toBe(0)
    await expect(page).toHaveURL(/\/register$/)
  })
}

test('blank fields and mismatched passwords show inline errors', async ({ page }) => {
  await page.goto('/register')
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page.getByLabel('Full name')).toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByLabel('Work email')).toHaveAttribute('aria-invalid', 'true')
  await fillRegistration(page)
  await page.getByLabel('Confirm password').fill('Different-Password-123!')
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page.getByRole('alert')).toContainText('Passwords do not match')
  await expect(page.getByLabel('Confirm password')).toHaveAttribute('aria-invalid', 'true')
})

test('successful signup sends the API contract and advances to verification instructions', async ({ page }) => {
  let submitted: unknown
  await page.route('**/api/v1/auth/register', async route => {
    submitted = route.request().postDataJSON()
    await route.fulfill({ status: 201, json: { data: { user: { id: 'new-user' }, message: 'Check your email to verify your account.' } } })
  })
  await page.goto('/register')
  await fillRegistration(page)
  await page.getByLabel('Full name').fill('  Signup Tester  ')
  await page.getByLabel('Work email').fill('  signup@example.test  ')
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByRole('status')).toContainText(/Verify your email/i)
  expect(submitted).toEqual({ name: 'Signup Tester', email: 'signup@example.test', password })
})

for (const failure of [
  { status: 409, message: 'An account with this email already exists.' },
  { status: 503, message: 'The server is temporarily unavailable. Please try again.' },
]) {
  test(`signup displays an API ${failure.status} error and permits retry`, async ({ page }) => {
    await page.route('**/api/v1/auth/register', route => route.fulfill({
      status: failure.status,
      json: { error: { message: failure.message } },
    }))
    await page.goto('/register')
    await fillRegistration(page)
    await page.getByRole('button', { name: 'Create account' }).click()
    await expect(page.getByRole('alert')).toHaveText(failure.message)
    await expect(page.getByRole('button', { name: 'Create account' })).toBeEnabled()
    await expect(page.getByLabel('Work email')).toHaveValue('signup@example.test')
    await expect(page).toHaveURL(/\/register$/)
  })
}

test('an in-flight signup disables submission and then advances', async ({ page }) => {
  let finish: () => void = () => {}
  const responseReady = new Promise<void>(resolve => { finish = resolve })
  let requests = 0
  await page.route('**/api/v1/auth/register', async route => {
    requests++
    await responseReady
    await route.fulfill({ status: 201, json: { data: { user: { id: 'new-user' }, message: 'Check your email to verify your account.' } } })
  })
  await page.goto('/register')
  await fillRegistration(page)
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page.getByRole('button')).toBeDisabled()
  await page.getByLabel('Confirm password').press('Enter')
  expect(requests).toBe(1)
  finish()
  await expect(page).toHaveURL(/\/login$/)
})

test('login invalid input gives field errors without throwing', async ({ page }) => {
  let requests = 0
  await page.route('**/api/v1/auth/login', async route => {
    requests++
    await route.fulfill({ status: 400, json: {} })
  })
  await page.goto('/login')
  await page.getByRole('button', { name: 'Log in' }).click()
  await expect(page.getByLabel('Work email')).toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByRole('alert')).toHaveCount(2)
  expect(requests).toBe(0)
})

for (const viewport of [{ width: 320, height: 568 }, { width: 375, height: 667 }, { width: 667, height: 320 }]) {
  test(`signup remains usable at ${viewport.width} × ${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await page.goto('/register')
    await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Create your account' })).toBeInViewport()
    await expect(page.getByText('Use 12–128 characters.', { exact: true })).toBeVisible()
    await fillRegistration(page, '1234')
    await page.getByRole('button', { name: 'Create account' }).click()
    await expect(page.getByRole('alert')).toContainText('Use at least 12 characters')
    await page.getByRole('button', { name: 'Create account' }).scrollIntoViewIfNeeded()
    await expect(page.getByRole('button', { name: 'Create account' })).toBeInViewport()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })
}
