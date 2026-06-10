import { randomUUID } from 'crypto'
import { Response } from 'express'
import { AuthRequest } from '../middleware/auth.middleware'
import { eq, and, or, asc, desc, gte, lte, isNull, count, inArray, sql } from 'drizzle-orm'
import { db } from '../db'
import {
  jornada, estadisticaJornada, snapshotAlineacion, puntuacionJornada,
  miembroLiga, liga, jugador, jugadorEquipo, equipo, titularLiga, configPuntuacion, usuario,
  Division, Posicion, AccionPuntuacion, ResultadoPartido,
} from '../db/schema'
import { registrarAccion } from '../lib/registrarAccion'

// ─── HELPERS ───────────────────────────────────────

function rand(min: number, max: number) { return Math.floor(Math.random() * (max - min + 1)) + min }
function prob(p: number)                { return Math.random() < p }

function getPuntos(config: { posicion: Posicion | null; accion: AccionPuntuacion; puntos: number }[], accion: AccionPuntuacion, posicion: Posicion): number {
  return config.find(c => c.accion === accion && c.posicion === posicion)?.puntos
    ?? config.find(c => c.accion === accion && c.posicion === null)?.puntos ?? 0
}

function calcularPuntos(
  stats: { convocado: boolean; titular: boolean; minutosJugados: number; goles: number; tarjetasAmarillas: number; tarjetaRoja: boolean; resultado: ResultadoPartido },
  posicion: Posicion,
  config: { posicion: Posicion | null; accion: AccionPuntuacion; puntos: number }[]
) {
  const desglose: Record<string, unknown> = {}
  let total = 0
  if (stats.convocado)             { const p = getPuntos(config, 'CONVOCADO', posicion);        desglose.convocado = p; total += p }
  if (stats.titular)               { const p = getPuntos(config, 'TITULAR', posicion);          desglose.titular   = p; total += p }
  if (stats.minutosJugados > 60)   { const p = getPuntos(config, 'MINUTOS_60', posicion);       desglose.minutos60 = p; total += p }
  if (stats.goles > 0)             { const u = getPuntos(config, 'GOL', posicion); const t = u * stats.goles; desglose.goles = { cantidad: stats.goles, puntosUnitarios: u, total: t }; total += t }
  if (stats.tarjetasAmarillas > 0) { const u = getPuntos(config, 'TARJETA_AMARILLA', posicion); const t = u * stats.tarjetasAmarillas; desglose.tarjetasAmarillas = { cantidad: stats.tarjetasAmarillas, puntosUnitarios: u, total: t }; total += t }
  if (stats.tarjetaRoja)           { const p = getPuntos(config, 'TARJETA_ROJA', posicion);     desglose.tarjetaRoja = p; total += p }
  const accionRes: AccionPuntuacion = stats.resultado === 'VICTORIA' ? 'VICTORIA' : stats.resultado === 'EMPATE' ? 'EMPATE' : 'DERROTA'
  const pRes = getPuntos(config, accionRes, posicion)
  desglose.resultado = { tipo: stats.resultado, puntos: pRes }
  total += pRes
  return { total, desglose }
}

// ─── CREAR JORNADA ─────────────────────────────────

export const crearJornada = async (req: AuthRequest, res: Response) => {
  const { division, numJornada, fechaCierre } = req.body
  if (!division || !numJornada || !fechaCierre) { res.status(400).json({ error: 'division, numJornada y fechaCierre son obligatorios' }); return }

  try {
    const id = randomUUID()
    await db.insert(jornada).values({ id, division, numJornada, fechaCierre: new Date(fechaCierre) })
    const [j] = await db.select().from(jornada).where(eq(jornada.id, id)).limit(1)
    await registrarAccion(req.usuarioId!, 'CREAR_JORNADA', 'Jornada', id, j)
    res.status(201).json(j)
  } catch {
    res.status(409).json({ error: 'Ya existe esa jornada para esa división' })
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
      db.select({ id: puntuacionJornada.jornadaId, total: count() }).from(puntuacionJornada).where(inArray(puntuacionJornada.jornadaId, ids)).groupBy(puntuacionJornada.jornadaId),
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
      and(eq(configPuntuacion.activo, true), lte(configPuntuacion.desde, j.fechaCierre),
          or(isNull(configPuntuacion.hasta), gte(configPuntuacion.hasta, j.fechaCierre)))
    )

    const jeRaw = await db.select({
      jeId: jugadorEquipo.id, jeJugadorId: jugadorEquipo.jugadorId, jeEquipoId: jugadorEquipo.equipoId,
      jeDesde: jugadorEquipo.desde, jeHasta: jugadorEquipo.hasta, jeActivo: jugadorEquipo.activo, jeCreadoEn: jugadorEquipo.creadoEn,
      jPosicion: jugador.posicion,
      eDivision: equipo.division,
    }).from(jugadorEquipo)
      .innerJoin(jugador, eq(jugador.id, jugadorEquipo.jugadorId))
      .innerJoin(equipo, eq(equipo.id, jugadorEquipo.equipoId))
      .where(eq(jugadorEquipo.activo, true))
    const jugadoresEquipo = jeRaw.map(r => ({
      id: r.jeId, jugadorId: r.jeJugadorId, equipoId: r.jeEquipoId,
      desde: r.jeDesde, hasta: r.jeHasta, activo: r.jeActivo, creadoEn: r.jeCreadoEn,
      jugador: { posicion: r.jPosicion }, equipo: { division: r.eDivision },
    }))
    const jugadoresEquipoDivision = jugadoresEquipo.filter(je => je.equipo.division === j.division)

    const resultadosPorEquipo = new Map<string, ResultadoPartido>()
    const resultados: ResultadoPartido[] = ['VICTORIA', 'EMPATE', 'DERROTA']
    const estadisticas = []

    for (const je of jugadoresEquipoDivision) {
      if (!resultadosPorEquipo.has(je.equipoId)) resultadosPorEquipo.set(je.equipoId, resultados[rand(0, 2)])
      const resultado        = resultadosPorEquipo.get(je.equipoId)!
      const convocado        = prob(0.75)
      const titular          = convocado && prob(0.65)
      const minutosJugados   = titular ? rand(45, 95) : convocado && prob(0.4) ? rand(1, 44) : 0
      const goles            = minutosJugados > 0 ? (prob(0.12) ? rand(1, 2) : 0) : 0
      const tarjetasAmarillas = minutosJugados > 0 ? (prob(0.15) ? 1 : 0) : 0
      const tarjetaRoja      = minutosJugados > 0 && !tarjetasAmarillas && prob(0.03)
      const { total, desglose } = calcularPuntos({ convocado, titular, minutosJugados, goles, tarjetasAmarillas, tarjetaRoja, resultado }, je.jugador.posicion, config)
      estadisticas.push({ id: randomUUID(), jornadaId, jugadorEquipoId: je.id, convocado, titular, minutosJugados, goles, tarjetasAmarillas, tarjetaRoja, resultado, puntosCalculados: total, desglose: desglose as any })
    }

    if (estadisticas.length > 0) await db.insert(estadisticaJornada).values(estadisticas)
    await registrarAccion(req.usuarioId!, 'SIMULAR_JORNADA', 'Jornada', jornadaId, { jornadaId, total: estadisticas.length })
    res.json({ mensaje: `${estadisticas.length} estadísticas simuladas`, jornadaId })
  } catch (e: any) {
    res.status(500).json({ error: e.message ?? 'Error al simular' })
  }
}

// ─── GENERAR SNAPSHOT ──────────────────────────────

export const generarSnapshot = async (req: AuthRequest, res: Response) => {
  const jornadaId = req.params.jornadaId as string

  try {
    const [j] = await db.select().from(jornada).where(eq(jornada.id, jornadaId)).limit(1)
    if (!j) { res.status(404).json({ error: 'Jornada no encontrada' }); return }

    const [{ total: yaExiste }] = await db.select({ total: count() }).from(snapshotAlineacion).where(eq(snapshotAlineacion.jornadaId, jornadaId))
    if (yaExiste > 0) { res.status(409).json({ error: 'Esta jornada ya tiene snapshot generado' }); return }

    const ligas = await db.select({ id: liga.id }).from(liga).where(eq(liga.division, j.division))
    const ligaIds = ligas.map(l => l.id)
    if (ligaIds.length === 0) { res.json({ mensaje: 'No hay ligas en esta división', jornadaId }); return }

    const miembros = await db.select().from(miembroLiga).where(inArray(miembroLiga.ligaId, ligaIds))
    const miembroIds = miembros.map(m => m.id)

    const titularesRaw = miembroIds.length > 0
      ? await db
          .select({ miembroLigaId: titularLiga.miembroLigaId, jugadorId: titularLiga.jugadorId, jeId: jugadorEquipo.id })
          .from(titularLiga)
          .innerJoin(jugadorEquipo, and(eq(jugadorEquipo.jugadorId, titularLiga.jugadorId), eq(jugadorEquipo.activo, true)))
          .where(inArray(titularLiga.miembroLigaId, miembroIds))
      : []

    const miembroMap = new Map(miembros.map(m => [m.id, m]))
    const snapshots: { id: string; jornadaId: string; miembroLigaId: string; jugadorEquipoId: string; esCapitan: boolean; creadoEn: Date }[] = []
    const seen = new Set<string>()

    for (const r of titularesRaw) {
      const key = `${r.miembroLigaId}:${r.jugadorId}`
      if (seen.has(key)) continue
      seen.add(key)
      const miembro = miembroMap.get(r.miembroLigaId)
      if (!miembro) continue
      snapshots.push({ id: randomUUID(), jornadaId, miembroLigaId: r.miembroLigaId, jugadorEquipoId: r.jeId, esCapitan: miembro.capitanId === r.jugadorId, creadoEn: new Date() })
    }

    if (snapshots.length > 0) await db.insert(snapshotAlineacion).ignore().values(snapshots)
    await registrarAccion(req.usuarioId!, 'GENERAR_SNAPSHOT', 'Jornada', jornadaId, { jornadaId, total: snapshots.length })
    res.json({ mensaje: `Snapshot generado: ${snapshots.length} entradas`, jornadaId })
  } catch (e: any) {
    res.status(500).json({ error: e.message ?? 'Error al generar snapshot' })
  }
}

// ─── CALCULAR PUNTUACIONES ─────────────────────────

export const calcularPuntuaciones = async (req: AuthRequest, res: Response) => {
  const jornadaId = req.params.jornadaId as string

  try {
    const [j] = await db.select().from(jornada).where(eq(jornada.id, jornadaId)).limit(1)
    if (!j) { res.status(404).json({ error: 'Jornada no encontrada' }); return }

    const snapshots = await db.select().from(snapshotAlineacion).where(eq(snapshotAlineacion.jornadaId, jornadaId))
    if (snapshots.length === 0) { res.status(409).json({ error: 'No hay snapshots para esta jornada. Genera primero el cierre de jornada.' }); return }

    const estadisticas = await db.select().from(estadisticaJornada).where(eq(estadisticaJornada.jornadaId, jornadaId))
    const statsMap     = new Map(estadisticas.map(e => [e.jugadorEquipoId, e]))
    const porMiembro   = new Map<string, typeof snapshots>()

    for (const s of snapshots) {
      if (!porMiembro.has(s.miembroLigaId)) porMiembro.set(s.miembroLigaId, [])
      porMiembro.get(s.miembroLigaId)!.push(s)
    }

    let calculados = 0
    for (const [miembroLigaId, snaps] of porMiembro) {
      let totalPuntos = 0
      for (const snap of snaps) {
        const stats = statsMap.get(snap.jugadorEquipoId)
        if (!stats) continue
        totalPuntos += snap.esCapitan ? stats.puntosCalculados * 2 : stats.puntosCalculados
      }

      await db.insert(puntuacionJornada)
        .values({ id: randomUUID(), jornadaId, miembroLigaId, puntos: totalPuntos })
        .onDuplicateKeyUpdate({ set: { puntos: totalPuntos } })
      await db.update(miembroLiga)
        .set({ puntuacion: sql`${miembroLiga.puntuacion} + ${totalPuntos}` })
        .where(eq(miembroLiga.id, miembroLigaId))
      calculados++
    }

    await registrarAccion(req.usuarioId!, 'CALCULAR_PUNTUACIONES', 'Jornada', jornadaId, { jornadaId, equipos: calculados })
    res.json({ mensaje: `Puntuaciones calculadas para ${calculados} equipos`, jornadaId })
  } catch (e: any) {
    res.status(500).json({ error: e.message ?? 'Error al calcular puntuaciones' })
  }
}

// ─── DETALLE PUNTUACIONES ──────────────────────────

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
      .innerJoin(jugador, eq(jugador.id, jugadorEquipo.jugadorId))
      .where(and(eq(snapshotAlineacion.jornadaId, jornadaId), eq(snapshotAlineacion.miembroLigaId, miembro.id)))

    const jeIds = snapsRaw.map(r => r.jeId)
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
