import { PrismaClient, Posicion, AccionPuntuacion } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'

const adapter = new PrismaPg({ connectionString: 'postgresql://fantasy_user:fantasy_pass@localhost:5432/fantasy_futbol' })
const prisma = new PrismaClient({ adapter })

const DESDE = new Date('2025-08-01')

const CONFIG: { posicion: Posicion | null; accion: AccionPuntuacion; puntos: number; descripcion: string }[] = [
  // Acciones globales (todas las posiciones)
  { posicion: null, accion: 'CONVOCADO',        puntos:  1, descripcion: 'Estar convocado' },
  { posicion: null, accion: 'TITULAR',           puntos:  2, descripcion: 'Salir de titular' },
  { posicion: null, accion: 'MINUTOS_60',        puntos:  1, descripcion: 'Jugar más de 60 minutos' },
  { posicion: null, accion: 'TARJETA_AMARILLA',  puntos: -1, descripcion: 'Tarjeta amarilla' },
  { posicion: null, accion: 'TARJETA_ROJA',      puntos: -3, descripcion: 'Tarjeta roja' },
  { posicion: null, accion: 'VICTORIA',          puntos:  3, descripcion: 'Victoria del equipo' },
  { posicion: null, accion: 'EMPATE',            puntos:  1, descripcion: 'Empate del equipo' },
  { posicion: null, accion: 'DERROTA',           puntos:  0, descripcion: 'Derrota del equipo' },

  // Goles por posición
  { posicion: 'PORTERO',        accion: 'GOL', puntos: 8, descripcion: 'Gol de portero' },
  { posicion: 'DEFENSA',        accion: 'GOL', puntos: 6, descripcion: 'Gol de defensa' },
  { posicion: 'CENTROCAMPISTA', accion: 'GOL', puntos: 5, descripcion: 'Gol de centrocampista' },
  { posicion: 'DELANTERO',      accion: 'GOL', puntos: 4, descripcion: 'Gol de delantero' },
  { posicion: 'UNKNOWN',        accion: 'GOL', puntos: 4, descripcion: 'Gol (posición desconocida)' },
]

async function main() {
  console.log('Insertando configuración de puntuación...')

  // Desactivar cualquier config activa previa
  await prisma.configPuntuacion.updateMany({
    where: { activo: true },
    data: { activo: false, hasta: DESDE },
  })

  for (const c of CONFIG) {
    await prisma.configPuntuacion.create({
      data: {
        posicion: c.posicion as Posicion | null,
        accion: c.accion,
        puntos: c.puntos,
        desde: DESDE,
        activo: true,
        descripcion: c.descripcion,
      },
    })
  }

  console.log(`✅ ${CONFIG.length} reglas de puntuación insertadas`)
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
