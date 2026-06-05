import path from 'path'
import { defineConfig } from 'prisma/config'
import { PrismaPg } from '@prisma/adapter-pg'
import dotenv from 'dotenv'

dotenv.config()

export default defineConfig({
  earlyAccess: true,
  schema: path.join('prisma', 'schema.prisma'),
  migrations: {
    seed: 'ts-node ./prisma/seed.ts',
  },
  migrate: {
    async adapter() {
      return new PrismaPg({ connectionString: process.env.DATABASE_URL! })
    }
  }
})
