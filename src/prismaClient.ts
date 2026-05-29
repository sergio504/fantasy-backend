import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'

const adapter = new PrismaPg({
  connectionString: 'postgresql://fantasy_user:fantasy_pass@localhost:5432/fantasy_futbol',
})

export const prisma = new PrismaClient({ adapter })