import { randomUUID } from 'crypto'
import { Response } from 'express'
import { AuthRequest } from '../middleware/auth.middleware'
import { eq, and, or, asc, desc, gte, lte, isNull, count, inArray } from 'drizzle-orm'
import { db } from '../db'
import {
  jornada, estadisticaJornada, snapshotAlineacion, puntuacionJornada,
  miembroLiga, jugador, jugadorEquipo, equipo, configPuntuacion, usuario,
  Division, Posicion, ResultadoPartido,
} from '../db/schema'
import { registrarAccion } from '../lib/registrarAccion'
import {
  calcularPuntos, generarSnapshotOp, calcularPuntosPorJugadorOp, calcularPuntuacionesOp,
} from '../lib/jornadaOps'

// ─── HELPERS (solo usados por simularJornada) ──────

function rand(min: number, max: number) { return Math.floor(Math.random() * (max - min + 1)) + min }
function prob(p: number)                { return Math.random() < p }

// ─── CREAR / EDITAR JORNADA ────────────────────────

export const crearJornada = async (req: AuthRequest, res: Response) => {
  const { division, numJornada, fechaInicioJornada, fechaFinJornada } = req.body
  if (!division || !numJornada) { res.status(400).json({ error: 'division y numJornada son obligatorios' }); return }

  try {
    const id = randomUUID()
    await db.insert(jornada).values({
      id, division, numJornada,
      fechaInicioJornada: fechaInicioJornada ? new Date(fechaInicioJornada) : null,
      fechaFinJornada:    fechaFinJornada    ? new Date(fechaFinJornada)    : null,
    })
    const [j] = await db.select().from(jornada).where(eq(jornada.id, id)).limit(1)
    await registrarAccion(req.usuarioId!, 'CREAR_JORNADA', 'Jornada', id, j)
    res.status(201).json(j)
  } catch {
    res.status(409).json({ error: 'Ya existe esa jornada para esa división' })
  }
}

export const editarJornada = async (req: AuthRequest, res: Response) => {
  const jornadaId = req.params.jornadaId as string
  const { fechaInicioJornada, fechaFinJornada, fechaImportacion } = req.body

  try {
    const [j] = await db.select().from(jornada).where(eq(jornada.id, jornadaId)).limit(1)
    if (!j) { res.status(404).json({ error: 'Jornada no encontrada' }); return }

    const set: { fechaInicioJornada?: Date | null; fechaFinJornada?: Date | null; fechaImportacion?: Date | null } = {}
    if (fechaInicioJornada !== undefined) set.fechaInicioJornada = fechaInicioJornada ? new Date(fechaInicioJornada) : null
    if (fechaFinJornada    !== undefined) set.fechaFinJornada    = fechaFinJornada    ? new Date(fechaFinJornada)    : null
    if (fechaImportacion   !== undefined) set.fechaImportacion   = fechaImportacion   ? new Date(fechaImportacion)   : null

    if (Object.keys(set).length === 0) { res.status(400).json({ error: 'Nada que actualizar' }); return }

    await db.update(jornada).set(set).where(eq(jornada.id, jornadaId))
    const [updated] = await db.select().from(jornada).where(eq(jornada.id, jornadaId)).limit(1)
    res.json(updated)
  } catch (e: any) {
    res.status(500).json({ error: e.message ?? 'Error al editar jornada' })
  }
}

export const getJornadas = async (req: AuthRequest, res: Response) => {
  const { division } = req.query

  try {
    const jornadasRaw = await db.select().from(jornada)
      .where(division ? eq(jornada.division, division as Division) : undefined)
      .orderBy(asc(jornada.division), asc(jornada.numJornada))

    if (jornadasRaw.length === 0) { res.json([]); return }

    const ids = jornadasRaw.map(j => j.id)
    const [estCounts, snapCounts, puntCounts] = await Promise.all([
      db.select({ id: estadisticaJornada.jornadaId, total: count() }).from(estadisticaJornada).where(inArray(estadisticaJornada.jornadaId, ids)).groupBy(estadisticaJornada.jornadaId),
      db.select({ id: snapshotAlineacion.jornadaId, total: count() }).from(snapshotAlineacion).where(inArray(snapshotAlineacion.jornadaId, ids)).groupBy(snapshotAlineacion.jornadaId),
      db.select({ id: puntuacionJornada.jornadaId,  total: count() }).from(puntuacionJornada).where(inArray(puntuacionJornada.jornadaId,  ids)).groupBy(puntuacionJornada.jornadaId),
    ])
    const estMap  = new Map(estCounts.map(c => [c.id, c.total]))
    const snapMap = new Map(snapCounts.map(c => [c.id, c.total]))
    const puntMap = new Map(puntCounts.map(c => [c.id, c.total]))

    res.json(jornadasRaw.map(j => ({ ...j, _count: { estadisticas: estMap.get(j.id) ?? 0, snapshots: snapMap.get(j.id) ?? 0, puntuaciones: puntMap.get(j.id) ?? 0 } })))
  } catch {
    res.status(500).json({ error: 'Error al obtener jornadas' })
  }
}

// ─── SIMULAR ESTADÍSTICAS ──────────────────────────

export const simularJornada = async (req: AuthRequest, res: Response) => {
  const jornadaId = req.params.jornadaId as string

  try {
    const [j] = await db.select().from(jornada).where(eq(jornada.id, jornadaId)).limit(1)
    if (!j) { res.status(404).json({ error: 'Jornada no encontrada' }); return }

    const [{ total: yaSimulada }] = await db.select({ total: count() }).from(estadisticaJornada).where(eq(estadisticaJornada.jornadaId, jornadaId))
    if (yaSimulada > 0) { res.status(409).json({ error: 'Esta jornada ya tiene estadísticas. Bórralas primero.' }); return }

    const config = await db.select().from(configPuntuacion).where(
      and(eq(configPuntuacion.activo, true), lte(configPuntuacion.desde, j.fechaInicioJornada ?? new Date()),
          or(isNull(configPuntuacion.hasta), gte(configPuntuacion.hasta, j.fechaInicioJornada ?? new Date())))
    )

    const jeRaw = await db.select({
      jeId: jugadorEquipo.id, jeJugadorId: jugadorEquipo.jugadorId, jeEquipoId: jugadorEquipo.equipoId,
      jeDesde: jugadorEquipo.desde, jeHasta: jugadorEquipo.hasta, jeActivo: jugadorEquipo.activo, jeCreadoEn: jugadorEquipo.creadoEn,
      jPosicion: jugador.posicion,
      eDivision: equipo.division,
    }).from(jugadorEquipo)
      .innerJoin(jugador, eq(jugador.id, jugadorEquipo.jugadorId))
      .innerJoin(equipo,  eq(equipo.id,  jugadorEquipo.equipoId))
      .where(eq(jugadorEquipo.activo, true))

    const jugadoresEquipoDivision = jeRaw
      .map(r => ({ id: r.jeId, jugadorId: r.jeJugadorId, equipoId: r.jeEquipoId, desde: r.jeDesde, hasta: r.jeHasta, activo: r.jeActivo, creadoEn: r.jeCreadoEn, jugador: { posicion: r.jPosicion }, equipo: { division: r.eDivision } }))
      .filter(je => je.equipo.division === j.division)

    const resultadosPorEquipo = new Map<string, ResultadoPartido>()
    const resultados: ResultadoPartido[] = ['VICTORIA', 'EMPATE', 'DERROTA']
    const estadisticas = []

    for (const je of jugadoresEquipoDivision) {
      if (!resultadosPorEquipo.has(je.equipoId)) resultadosPorEquipo.set(je.equipoId, resultados[rand(0, 2)])
      const resultado         = resultadosPorEquipo.get(je.equipoId)!
      const convocado         = prob(0.75)
      const titular           = convocado && prob(0.65)
      const minutosJugados    = titular ? rand(45, 95) : convocado && prob(0.4) ? rand(1, 44) : 0
      const goles             = minutosJugados > 0 ? (prob(0.12) ? rand(1, 2) : 0) : 0
      const tarjetasAmarillas = minutosJugados > 0 ? (prob(0.15) ? 1 : 0) : 0
      const tarjetaRoja       = minutosJugados > 0 && !tarjetasAmarillas && prob(0.03)
      const { total, desglose } = calcularPuntos(
        { convocado, titular, minutosJugados, goles, golesDePenalti: 0, golEnPropia: 0, golesAFavor: 0, golesEncajados: 0, diferenciaGoles: 0, tarjetasAmarillas, tarjetaRoja, resultado },
        je.jugador.posicion as Posicion, config,
      )
      estadisticas.push({ id: randomUUID(), jornadaId, jugadorEquipoId: je.id, convocado, titular, minutosJugados, goles, golesDePenalti: 0, tarjetasAmarillas, tarjetaRoja, resultado, puntosCalculados: total, desglose: desglose as any })
    }

    if (estadisticas.length > 0) await db.insert(estadisticaJornada).values(estadisticas)
    await registrarAccion(req.usuarioId!, 'SIMULAR_JORNADA', 'Jornada', jornadaId, { jornadaId, total: estadisticas.length })
    res.json({ mensaje: `${estadisticas.length} estadísticas simuladas`, jornadaId })
  } catch (e: any) {
    res.status(500).json({ error: e.message ?? 'Error al simular' })
  }
}

// ─── SNAPSHOT / PUNTOS / PUNTUACIONES ─────────────

export const generarSnapshot = async (req: AuthRequest, res: Response) => {
  const jornadaId = req.params.jornadaId as string
  try {
    const mensaje = await generarSnapshotOp(jornadaId, req.usuarioId!)
    res.json({ mensaje, jornadaId })
  } catch (e: any) {
    const status = e.message?.includes('no encontrada') ? 404 : e.message?.includes('ya tiene') ? 409 : 500
    res.status(status).json({ error: e.message ?? 'Error al generar snapshot' })
  }
}

export const calcularPuntosPorJugador = async (req: AuthRequest, res: Response) => {
  const jornadaId = req.params.jornadaId as string
  try {
    const mensaje = await calcularPuntosPorJugadorOp(jornadaId, req.usuarioId!)
    res.json({ mensaje, jornadaId })
  } catch (e: any) {
    const status = e.message?.includes('no encontrada') ? 404 : 500
    res.status(status).json({ error: e.message ?? 'Error al calcular puntos' })
  }
}

export const calcularPuntuaciones = async (req: AuthRequest, res: Response) => {
  const jornadaId = req.params.jornadaId as string
  try {
    const mensaje = await calcularPuntuacionesOp(jornadaId, req.usuarioId!)
    res.json({ mensaje, jornadaId })
  } catch (e: any) {
    const status = e.message?.includes('no encontrada') ? 404 : e.message?.includes('No hay snapshots') ? 409 : 500
    res.status(status).json({ error: e.message ?? 'Error al calcular puntuaciones' })
  }
}

// ─── PUNTUACIONES / ESTADÍSTICAS ──────────────────

export const getPuntuacionesJornada = async (req: AuthRequest, res: Response) => {
  const { ligaId, jornadaId } = req.params as { ligaId: string; jornadaId: string }

  try {
    const rows = await db
      .select({
        id:            puntuacionJornada.id,
        jornadaId:     puntuacionJornada.jornadaId,
        miembroLigaId: puntuacionJornada.miembroLigaId,
        puntos:        puntuacionJornada.puntos,
        username:      usuario.username,
      })
      .from(puntuacionJornada)
      .innerJoin(miembroLiga, eq(miembroLiga.id, puntuacionJornada.miembroLigaId))
      .innerJoin(usuario, eq(usuario.id, miembroLiga.usuarioId))
      .where(and(eq(puntuacionJornada.jornadaId, jornadaId), eq(miembroLiga.ligaId, ligaId)))
      .orderBy(desc(puntuacionJornada.puntos))

    res.json(rows.map(r => ({ id: r.id, jornadaId: r.jornadaId, miembroLigaId: r.miembroLigaId, puntos: r.puntos, miembroLiga: { usuario: { username: r.username } } })))
  } catch {
    res.status(500).json({ error: 'Error al obtener puntuaciones' })
  }
}

export const getEstadisticasJornada = async (req: AuthRequest, res: Response) => {
  const { ligaId, jornadaId } = req.params as { ligaId: string; jornadaId: string }
  const usuarioId = req.usuarioId!

  try {
    const miembro = await db.query.miembroLiga.findFirst({ where: and(eq(miembroLiga.ligaId, ligaId), eq(miembroLiga.usuarioId, usuarioId)) })
    if (!miembro) { res.status(403).json({ error: 'No eres miembro de esta liga' }); return }

    const snapsRaw = await db
      .select({
        snapId: snapshotAlineacion.id, snapMiembroLigaId: snapshotAlineacion.miembroLigaId,
        snapJugadorEquipoId: snapshotAlineacion.jugadorEquipoId, snapEsCapitan: snapshotAlineacion.esCapitan,
        jeId: jugadorEquipo.id,
        jugNombreCompleto: jugador.nombreCompleto, jugPosicion: jugador.posicion,
      })
      .from(snapshotAlineacion)
      .innerJoin(jugadorEquipo, eq(jugadorEquipo.id, snapshotAlineacion.jugadorEquipoId))
      .innerJoin(jugador,       eq(jugador.id, jugadorEquipo.jugadorId))
      .where(and(eq(snapshotAlineacion.jornadaId, jornadaId), eq(snapshotAlineacion.miembroLigaId, miembro.id)))

    const jeIds    = snapsRaw.map(r => r.jeId)
    const statsRows = jeIds.length > 0
      ? await db.select().from(estadisticaJornada)
          .where(and(eq(estadisticaJornada.jornadaId, jornadaId), inArray(estadisticaJornada.jugadorEquipoId, jeIds)))
      : []
    const statsMap = new Map(statsRows.map(s => [s.jugadorEquipoId, s]))

    res.json(snapsRaw.map(r => {
      const stats  = statsMap.get(r.jeId) ?? null
      const puntos = stats ? (r.snapEsCapitan ? stats.puntosCalculados * 2 : stats.puntosCalculados) : null
      return { jugador: { nombreCompleto: r.jugNombreCompleto, posicion: r.jugPosicion }, esCapitan: r.snapEsCapitan, estadistica: stats, puntos }
    }))
  } catch {
    res.status(500).json({ error: 'Error al obtener estadísticas' })
  }
}
