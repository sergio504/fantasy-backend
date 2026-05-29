import path from 'path'
import { defineConfig } from 'prisma/config'

export default defineConfig({
  earlyAccess: true,
  schema: path.join('prisma', 'schema.prisma'),
  datasource: {
    url: 'postgresql://fantasy_user:fantasy_pass@localhost:5432/fantasy_futbol',
  },
  migrations: {
    seed: 'ts-node ./prisma/seed.ts',
  },
  migrate: {
    async adapter() {
      const { PrismaPg } = await import('@prisma/adapter-pg')
      return new PrismaPg({
        connectionString: 'postgresql://fantasy_user:fantasy_pass@localhost:5432/fantasy_futbol',
      })
    },
  },
})