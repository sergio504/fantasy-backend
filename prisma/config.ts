import path from 'path'
import { defineConfig } from 'prisma/config'

export default defineConfig({
  earlyAccess: true,
  schema: path.join('prisma', 'schema.prisma'),
  migrations: {
    seed: 'ts-node ./prisma/seed.ts',
  },
  datasource: {
    url: 'postgresql://fantasy_user:fantasy_pass@localhost:5432/fantasy_futbol',
  },
  migrate: {
    async adapter() {
      const { PrismaPg } = await import('@prisma/adapter-pg')
      const connectionString = process.env.DATABASE_URL!
      return new PrismaPg({ connectionString })
    }
  }
})