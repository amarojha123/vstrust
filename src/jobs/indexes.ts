import mongoose from 'mongoose';
import { connectDatabase } from '../config/database';
import { allModels } from '../models';
async function main() { await connectDatabase(); for (const model of allModels) await model.createIndexes(); await mongoose.disconnect(); }
main().catch(() => { process.stderr.write('Index creation failed. Check database connectivity and existing data constraints.\n'); process.exitCode = 1; });
