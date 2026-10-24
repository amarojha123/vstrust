import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import dotenv from 'dotenv'
import argon2 from 'argon2'
import mongoose from 'mongoose'

const root = resolve(process.cwd(), '../..')
const statePath = resolve(root, '.cache/playwright-e2e-state.json')
type ModelBag = { User: any; Organization: any; Membership: any; RateLimitBucket: any }

export default async function globalSetup() {
  dotenv.config({ path: resolve(root, '.env') })
  if (!process.env.MONGODB_URI) throw new Error('Set MONGODB_URI in the repository .env and start MongoDB before Playwright.')
  const require = createRequire(import.meta.url)
  const models = require(resolve(root, 'dist/models/index.js')) as ModelBag
  const id = randomBytes(5).toString('hex')
  const password = 'Playwright-Local-Password-123!'
  await mongoose.connect(process.env.MONGODB_URI)
  try {
    // E2E repeats share the local API database and client IP; remove only the
    // test traffic buckets so reruns do not inherit the previous rate limit.
    await models.RateLimitBucket.deleteMany({ _id: /^(api|auth):/ })
    const organization = await models.Organization.create({ name: `E2E ${id}`, slug: `e2e-${id}`, status: 'active' })
    const admin = await models.User.create({ name: 'E2E Admin', email: `admin-${id}@example.test`, passwordHash: await argon2.hash(password, { type: argon2.argon2id }), emailVerifiedAt: new Date(), status: 'active' })
    const reviewer = await models.User.create({ name: 'E2E Reviewer', email: `reviewer-${id}@example.test`, passwordHash: await argon2.hash(password, { type: argon2.argon2id }), emailVerifiedAt: new Date(), status: 'active' })
    await models.Membership.create([
      { organizationId: organization._id, userId: admin._id, role: 'admin', status: 'active' },
      { organizationId: organization._id, userId: reviewer._id, role: 'reviewer', status: 'active' },
    ])
    await mkdir(resolve(root, '.cache'), { recursive: true })
    await writeFile(statePath, JSON.stringify({ organizationId: String(organization._id), adminEmail: admin.email, reviewerEmail: reviewer.email, signupEmail: `signup-${id}@example.test`, password, adminId: String(admin._id), reviewerId: String(reviewer._id) }), 'utf8')
  } finally { await mongoose.disconnect() }
}
