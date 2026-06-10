import { Request, Response } from 'express'
import { eq, desc, inArray, and } from 'drizzle-orm'
import { db } from '../db'
import { jugador, jugadorEquipo, estadisticaJornada, jornada, snapshotAlineacion, miembroLiga, usuario, Posicion } from '../db/schema'

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
  const id     = req.params.id as string
  const ligaId = req.query.ligaId as string | undefined

  try {
    const equipos   = await db.select({ id: jugadorEquipo.id }).from(jugadorEquipo).where(eq(jugadorEquipo.jugadorId, id))
    const equipoIds = equipos.map(e => e.id)
    if (equipoIds.length === 0) { res.json([]); return }

    const estadisticas = await db
      .select({
        id: estadisticaJornada.id, jornadaId: estadisticaJornada.jornadaId,
        jugadorEquipoId: estadisticaJornada.jugadorEquipoId, convocado: estadisticaJornada.convocado,
        titular: estadisticaJornada.titular, minutosJugados: estadisticaJornada.minutosJugados,
        goles: estadisticaJornada.goles, tarjetasAmarillas: estadisticaJornada.tarjetasAmarillas,
        tarjetaRoja: estadisticaJornada.tarjetaRoja, resultado: estadisticaJornada.resultado,
        golesEncajados: estadisticaJornada.golesEncajados, golesAFavor: estadisticaJornada.golesAFavor,
        golEnPropia: estadisticaJornada.golEnPropia, diferenciaGoles: estadisticaJornada.diferenciaGoles,
        puntosCalculados: estadisticaJornada.puntosCalculados, desglose: estadisticaJornada.desglose,
        jornada: { numJornada: jornada.numJornada, division: jornada.division, fechaCierre: jornada.fechaCierre },
      })
      .from(estadisticaJornada)
      .innerJoin(jornada, eq(jornada.id, estadisticaJornada.jornadaId))
      .where(inArray(estadisticaJornada.jugadorEquipoId, equipoIds))
      .orderBy(estadisticaJornada.id)

    // Si se pasa ligaId, buscar quién tenía al jugador en cada jornada dentro de esa liga
    let propietarioMap = new Map<string, string>()
    if (ligaId && equipoIds.length > 0) {
      const snapshots = await db
        .select({
          jornadaId:       snapshotAlineacion.jornadaId,
          jugadorEquipoId: snapshotAlineacion.jugadorEquipoId,
          username:        usuario.username,
        })
        .from(snapshotAlineacion)
        .innerJoin(miembroLiga, eq(miembroLiga.id, snapshotAlineacion.miembroLigaId))
        .innerJoin(usuario, eq(usuario.id, miembroLiga.usuarioId))
        .where(and(
          eq(miembroLiga.ligaId, ligaId),
          inArray(snapshotAlineacion.jugadorEquipoId, equipoIds),
        ))
      // clave: jornadaId|jugadorEquipoId → username
      propietarioMap = new Map(snapshots.map(s => [`${s.jornadaId}|${s.jugadorEquipoId}`, s.username]))
    }

    const resultado = estadisticas.map(e => ({
      ...e,
      propietario: propietarioMap.get(`${e.jornadaId}|${e.jugadorEquipoId}`) ?? null,
    }))

    res.json(resultado)
  } catch {
    res.status(500).json({ error: 'Error al obtener estadísticas' })
  }
}
