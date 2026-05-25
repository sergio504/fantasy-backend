import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import bcrypt from 'bcryptjs'
import * as dotenv from 'dotenv'

dotenv.config()

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! })
const prisma = new PrismaClient({ adapter })

async function main() {
  console.log('🌱 Sembrando base de datos...')

  const hashedPassword = await bcrypt.hash('password123', 10)
  await prisma.user.upsert({
    where: { email: 'admin@fantasy.com' },
    update: {},
    create: {
      email: 'admin@fantasy.com',
      username: 'admin',
      password: hashedPassword,
    },
  })

  const players = [
    { name: 'Courtois',    position: 'GOALKEEPER' as const, clubTeam: 'Real Madrid', price: 8  },
    { name: 'Carvajal',    position: 'DEFENDER'   as const, clubTeam: 'Real Madrid', price: 7  },
    { name: 'Pedri',       position: 'MIDFIELDER' as const, clubTeam: 'Barcelona',   price: 10 },
    { name: 'Bellingham',  position: 'MIDFIELDER' as const, clubTeam: 'Real Madrid', price: 12 },
    { name: 'Yamal',       position: 'FORWARD'    as const, clubTeam: 'Barcelona',   price: 14 },
    { name: 'Mbappé',      position: 'FORWARD'    as const, clubTeam: 'Real Madrid', price: 15 },
    { name: 'Lewandowski', position: 'FORWARD'    as const, clubTeam: 'Barcelona',   price: 11 },
  ]

  for (const player of players) {
    await prisma.player.upsert({
      where: { id: player.name },
      update: {},
      create: player,
    })
  }

  console.log('✅ Base de datos lista con datos de prueba')
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect())