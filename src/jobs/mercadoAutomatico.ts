import { prisma } from '../prismaClient'
import { cerrarOfertaLogic } from '../lib/cerrarOfertaLogic'

const JUGADORES_POR_EJECUCION = 15
const INTERVALO_DIAS = 3
const CADUCIDAD_DIAS = 3

function shuffle<T>(arr: T[]): T[] {
  return [...arr].sort(() => Math.random() - 0.5)
}

export async function ponerJugadoresEnMercado(): Promise<{ ligaId: string; nombre: string; añadidos: number }[]> {
  const ligas = await prisma.liga.findMany({
    where: { miembros: { some: {} } },
  })

  const resumen: { ligaId: string; nombre: string; añadidos: number }[] = []

  for (const liga of ligas) {
    // Comprobar si ya hay ofertas de sistema recientes (< INTERVALO_DIAS días)
    const limiteAntigüedad = new Date()
    limiteAntigüedad.setDate(limiteAntigüedad.getDate() - INTERVALO_DIAS)

    const ofertasRecientes = await prisma.ofertaMercado.count({
      where: {
        ligaId: liga.id,
        vendedorId: null,
        estado: 'ACTIVA',
        creadoEn: { gte: limiteAntigüedad },
      },
    })

    if (ofertasRecientes > 0) {
      resumen.push({ ligaId: liga.id, nombre: liga.nombre, añadidos: 0 })
      continue
    }

    // Jugadores ya asignados o ya en oferta activa en esta liga
    const [asignados, enOferta] = await Promise.all([
      prisma.plantillaFantasy.findMany({ where: { ligaId: liga.id }, select: { jugadorId: true } }),
      prisma.ofertaMercado.findMany({ where: { ligaId: liga.id, estado: 'ACTIVA' }, select: { jugadorId: true } }),
    ])

    const idsExcluidos = new Set([
      ...asignados.map(p => p.jugadorId),
      ...enOferta.map(o => o.jugadorId),
    ])

    // Jugadores libres de la división de esta liga
    const libres = await prisma.jugador.findMany({
      where: {
        id: { notIn: [...idsExcluidos] },
        historialEquipos: { some: { activo: true, equipo: { division: liga.division } } },
      },
      select: { id: true, valor: true },
    })

    if (libres.length === 0) {
      resumen.push({ ligaId: liga.id, nombre: liga.nombre, añadidos: 0 })
      continue
    }

    const seleccionados = shuffle(libres).slice(0, JUGADORES_POR_EJECUCION)

    const fechaCaducidad = new Date()
    fechaCaducidad.setDate(fechaCaducidad.getDate() + CADUCIDAD_DIAS)

    await prisma.ofertaMercado.createMany({
      data: seleccionados.map(j => ({
        ligaId: liga.id,
        jugadorId: j.id,
        vendedorId: null,        // oferta del sistema
        precioMinimo: j.valor,
        estado: 'ACTIVA' as const,
        fechaCaducidad,
      })),
    })

    resumen.push({ ligaId: liga.id, nombre: liga.nombre, añadidos: seleccionados.length })
  }

  return resumen
}

export async function resolverOfertasCaducadas(): Promise<{ resueltas: number; canceladas: number }> {
  const ahora = new Date()

  const caducadas = await prisma.ofertaMercado.findMany({
    where: {
      estado: 'ACTIVA',
      fechaCaducidad: { lte: ahora },
    },
    select: { id: true },
  })

  let resueltas = 0
  let canceladas = 0

  for (const oferta of caducadas) {
    try {
      const resultado = await cerrarOfertaLogic(oferta.id)
      if (resultado?.resultado === 'VENDIDA') resueltas++
      else if (resultado?.resultado === 'CANCELADA') canceladas++
    } catch (e) {
      console.error(`[JOB] Error al resolver oferta ${oferta.id}:`, e)
    }
  }

  return { resueltas, canceladas }
}
