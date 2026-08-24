import { Request, Response } from 'express'
import { eq, desc, inArray, and, asc } from 'drizzle-orm'
import { db } from '../db'
import { jugador, jugadorEquipo, equipo, estadisticaJornada, jornada, snapshotAlineacion, miembroLiga, usuario, historialValorJugador, historialClausula, Posicion } from '../db/schema'

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
    const equipos   = await db.select({ id: jugadorEquipo.id, equipoId: jugadorEquipo.equipoId, activo: jugadorEquipo.activo })
      .from(jugadorEquipo).where(eq(jugadorEquipo.jugadorId, id))
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
        jornada: { numJornada: jornada.numJornada, division: jornada.division, fechaInicioJornada: jornada.fechaInicioJornada, fechaFinJornada: jornada.fechaFinJornada },
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

    const conPropietario = estadisticas.map(e => ({
      ...e,
      propietario: propietarioMap.get(`${e.jornadaId}|${e.jugadorEquipoId}`) ?? null,
    }))

    // Rellena con "0 puntos" las jornadas ya jugadas de la división del
    // jugador en las que no tiene estadística (no convocado / no encontrado),
    // para que la lista y la gráfica del modal tengan una línea temporal
    // completa en vez de huecos.
    const equipoActivoId = equipos.find(e => e.activo)?.equipoId ?? equipos[0]?.equipoId
    const equipoInfo = equipoActivoId
      ? (await db.select({ division: equipo.division }).from(equipo).where(eq(equipo.id, equipoActivoId)).limit(1))[0]
      : undefined

    if (!equipoInfo) { res.json(conPropietario); return }

    const jornadasJugadas = await db
      .select({ id: jornada.id, numJornada: jornada.numJornada, division: jornada.division, fechaInicioJornada: jornada.fechaInicioJornada, fechaFinJornada: jornada.fechaFinJornada })
      .from(jornada)
      .where(and(eq(jornada.division, equipoInfo.division), eq(jornada.puntosPorJugadorCalculados, true)))
      .orderBy(asc(jornada.numJornada))

    const statsPorJornadaId = new Map(conPropietario.map(e => [e.jornadaId, e]))
    const resultado = jornadasJugadas.map(j => statsPorJornadaId.get(j.id) ?? {
      id: `sin-datos-${j.id}`, jornadaId: j.id, jugadorEquipoId: null,
      convocado: false, titular: false, minutosJugados: 0, goles: 0, tarjetasAmarillas: 0, tarjetaRoja: false,
      resultado: null, golesEncajados: 0, golesAFavor: 0, golEnPropia: 0, diferenciaGoles: 0,
      puntosCalculados: 0, desglose: null,
      jornada: { numJornada: j.numJornada, division: j.division, fechaInicioJornada: j.fechaInicioJornada, fechaFinJornada: j.fechaFinJornada },
      propietario: null,
    })

    res.json(resultado)
  } catch {
    res.status(500).json({ error: 'Error al obtener estadísticas' })
  }
}

export const getHistorialValorJugador = async (req: Request, res: Response) => {
  const jugadorId = req.params.id as string
  try {
    const rows = await db.select().from(historialValorJugador)
      .where(eq(historialValorJugador.jugadorId, jugadorId))
      .orderBy(asc(historialValorJugador.numJornada))
    res.json(rows)
  } catch {
    res.status(500).json({ error: 'Error al obtener historial de valor' })
  }
}

export const getHistorialClausulaJugador = async (req: Request, res: Response) => {
  const jugadorId = req.params.id as string
  const ligaId    = req.query.ligaId as string | undefined
  try {
    const rows = await db.select().from(historialClausula)
      .where(and(eq(historialClausula.jugadorId, jugadorId), ligaId ? eq(historialClausula.ligaId, ligaId) : undefined))
      .orderBy(asc(historialClausula.creadoEn))
    res.json(rows)
  } catch {
    res.status(500).json({ error: 'Error al obtener historial de cláusula' })
  }
}
