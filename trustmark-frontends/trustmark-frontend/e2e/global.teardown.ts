import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import dotenv from 'dotenv'
import mongoose from 'mongoose'

const root = resolve(process.cwd(), '../..')
type State = { organizationId: string; adminId: string; reviewerId: string; signupEmail: string }
type ModelBag = { User: any; Organization: any; Membership: any; ActionToken: any; Session: any; AuditEvent: any; allModels: any[] }

export default async function globalTeardown() {
  dotenv.config({ path: resolve(root, '.env') })
  const raw = await readFile(resolve(root, '.cache/playwright-e2e-state.json'), 'utf8').catch(() => '')
  if (!raw || !process.env.MONGODB_URI) return
  const state = JSON.parse(raw) as State
  const require = createRequire(import.meta.url)
  const models = require(resolve(root, 'dist/models/index.js')) as ModelBag
  await mongoose.connect(process.env.MONGODB_URI)
  try {
    const signup = await models.User.findOne({ email: state.signupEmail }).select('_id').lean()
    if (signup) {
      await models.ActionToken.collection.deleteMany({ userId: signup._id })
      await models.Session.collection.deleteMany({ userId: signup._id })
      await models.AuditEvent.collection.deleteMany({ actorId: signup._id })
      await models.User.collection.deleteOne({ _id: signup._id })
    }
    for (const model of models.allModels) {
      if (model.modelName === 'User') continue
      await model.collection.deleteMany({ organizationId: new mongoose.Types.ObjectId(state.organizationId) })
    }
    await models.User.collection.deleteMany({ _id: { $in: [new mongoose.Types.ObjectId(state.adminId), new mongoose.Types.ObjectId(state.reviewerId)] } })
    await models.Organization.collection.deleteOne({ _id: new mongoose.Types.ObjectId(state.organizationId) })
  } finally { await mongoose.disconnect() }
}
