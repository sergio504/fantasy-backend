import { randomUUID } from 'crypto'
import { eq, and, isNull, gte, lte, notInArray, count } from 'drizzle-orm'
import { db } from '../db'
import { liga, miembroLiga, ofertaMercado, plantillaFantasy, jugador, jugadorEquipo, equipo } from '../db/schema'
import { cerrarOfertaLogic } from '../lib/cerrarOfertaLogic'

const JUGADORES_POR_EJECUCION = 15
const INTERVALO_DIAS = 3
const CADUCIDAD_DIAS = 3

function shuffle<T>(arr: T[]): T[] {
  return [...arr].sort(() => Math.random() - 0.5)
}

export async function ponerJugadoresEnMercado(): Promise<{ ligaId: string; nombre: string; añadidos: number }[]> {
  const ligas = await db.query.liga.findMany({ with: { miembros: { limit: 1 } } })
  const ligasConMiembros = ligas.filter(l => l.miembros.length > 0)
  const resumen: { ligaId: string; nombre: string; añadidos: number }[] = []

  for (const l of ligasConMiembros) {
    const limiteAntigüedad = new Date()
    limiteAntigüedad.setDate(limiteAntigüedad.getDate() - INTERVALO_DIAS)

    const [{ total: ofertasRecientes }] = await db.select({ total: count() }).from(ofertaMercado).where(
      and(eq(ofertaMercado.ligaId, l.id), isNull(ofertaMercado.vendedorId), eq(ofertaMercado.estado, 'ACTIVA'), gte(ofertaMercado.creadoEn, limiteAntigüedad))
    )

    if (ofertasRecientes > 0) { resumen.push({ ligaId: l.id, nombre: l.nombre, añadidos: 0 }); continue }

    const [asignados, enOferta] = await Promise.all([
      db.select({ jugadorId: plantillaFantasy.jugadorId }).from(plantillaFantasy).where(eq(plantillaFantasy.ligaId, l.id)),
      db.select({ jugadorId: ofertaMercado.jugadorId }).from(ofertaMercado).where(and(eq(ofertaMercado.ligaId, l.id), eq(ofertaMercado.estado, 'ACTIVA'))),
    ])
    const idsExcluidos = [...asignados.map(p => p.jugadorId), ...enOferta.map(o => o.jugadorId)]

    const libres = await db.selectDistinct({ id: jugador.id, valor: jugador.valor }).from(jugador)
      .innerJoin(jugadorEquipo, and(eq(jugadorEquipo.jugadorId, jugador.id), eq(jugadorEquipo.activo, true)))
      .innerJoin(equipo, and(eq(equipo.id, jugadorEquipo.equipoId), eq(equipo.division, l.division)))
      .where(idsExcluidos.length > 0 ? notInArray(jugador.id, idsExcluidos) : undefined)

    if (libres.length === 0) { resumen.push({ ligaId: l.id, nombre: l.nombre, añadidos: 0 }); continue }

    const seleccionados  = shuffle(libres).slice(0, JUGADORES_POR_EJECUCION)
    const fechaCaducidad = new Date()
    fechaCaducidad.setDate(fechaCaducidad.getDate() + CADUCIDAD_DIAS)

    await db.insert(ofertaMercado).values(
      seleccionados.map(j => ({ id: randomUUID(), ligaId: l.id, jugadorId: j.id, vendedorId: null, precioMinimo: j.valor, estado: 'ACTIVA' as const, fechaCaducidad, creadoEn: new Date() }))
    )
    resumen.push({ ligaId: l.id, nombre: l.nombre, añadidos: seleccionados.length })
  }

  return resumen
}

export async function resolverOfertasCaducadas(): Promise<{ resueltas: number; canceladas: number }> {
  const ahora = new Date()
  const caducadas = await db.select({ id: ofertaMercado.id }).from(ofertaMercado)
    .where(and(eq(ofertaMercado.estado, 'ACTIVA'), lte(ofertaMercado.fechaCaducidad, ahora)))

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
