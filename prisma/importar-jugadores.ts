import { PrismaClient, Division, Posicion } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import * as fs from 'fs'
import * as path from 'path'

const adapter = new PrismaPg({ connectionString: 'postgresql://fantasy_user:fantasy_pass@localhost:5432/fantasy_futbol' })
const prisma = new PrismaClient({ adapter })

interface JugadorJSON {
  nombreCompleto: string
  nombre: string
  dorsal: number | null
  edad: number | null
  posicion: string
}

interface EntradaJSON {
  equipo: { nombre: string; division: string }
  jugadores: JugadorJSON[]
}

async function main() {
  const jsonPath = path.resolve(__dirname, '../../jugadores_3rfef.json')
  const datos: EntradaJSON[] = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'))

  console.log(`Importando ${datos.length} equipos...\n`)

  let totalJugadores = 0

  for (const entrada of datos) {
    const { equipo: equipoData, jugadores } = entrada

    // Buscar o crear el equipo
    let equipo = await prisma.equipo.findFirst({
      where: { nombre: equipoData.nombre, division: equipoData.division as Division },
    })
    if (!equipo) {
      equipo = await prisma.equipo.create({
        data: { nombre: equipoData.nombre, division: equipoData.division as Division },
      })
    }

    for (const j of jugadores) {
      const valor = Math.floor(Math.random() * 56) + 5 // 5–60

      const jugador = await prisma.jugador.create({
        data: {
          nombreCompleto: j.nombreCompleto,
          nombre: j.nombre,
          dorsal: j.dorsal ?? undefined,
          edad: j.edad ?? undefined,
          posicion: j.posicion as Posicion,
          valor,
        },
      })

      await prisma.jugadorEquipo.create({
        data: {
          jugadorId: jugador.id,
          equipoId: equipo.id,
          activo: true,
        },
      })
    }

    console.log(`✓ ${equipo.nombre} — ${jugadores.length} jugadores`)
    totalJugadores += jugadores.length
  }

  console.log(`\n✅ ${totalJugadores} jugadores importados en ${datos.length} equipos`)
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
