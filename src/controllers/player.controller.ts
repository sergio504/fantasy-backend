import { Request, Response } from 'express'
import { eq, desc, inArray } from 'drizzle-orm'
import { db } from '../db'
import { jugador, jugadorEquipo, estadisticaJornada, Posicion } from '../db/schema'

export const getJugadores = async (req: Request, res: Response) => {
  try {
    const { posicion } = req.query
    const jugadores = await db.query.jugador.findMany({
      where: posicion ? eq(jugador.posicion, posicion as Posicion) : undefined,
      orderBy: desc(jugador.valor),
    })
    res.json(jugadores)
  } catch {
    res.status(500).json({ error: 'Error al obtener jugadores' })
  }
}

export const getJugadorPorId = async (req: Request, res: Response) => {
  try {
    const j = await db.query.jugador.findFirst({ where: eq(jugador.id, req.params.id as string) })
    if (!j) { res.status(404).json({ error: 'Jugador no encontrado' }); return }
    res.json(j)
  } catch {
    res.status(500).json({ error: 'Error al obtener jugador' })
  }
}

export const getEstadisticasJugador = async (req: Request, res: Response) => {
  const id = req.params.id as string

  try {
    const equipos    = await db.select({ id: jugadorEquipo.id }).from(jugadorEquipo).where(eq(jugadorEquipo.jugadorId, id))
    const equipoIds  = equipos.map(e => e.id)
    if (equipoIds.length === 0) { res.json([]); return }

    const estadisticas = await db.query.estadisticaJornada.findMany({
      where:   inArray(estadisticaJornada.jugadorEquipoId, equipoIds),
      with:    { jornada: { columns: { numJornada: true, division: true, fechaCierre: true } } },
      orderBy: estadisticaJornada.id,
    })
    res.json(estadisticas)
  } catch {
    res.status(500).json({ error: 'Error al obtener estadísticas' })
  }
}
