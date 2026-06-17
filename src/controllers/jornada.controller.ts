import { randomUUID } from 'crypto'
import { Response } from 'express'
import { AuthRequest } from '../middleware/auth.middleware'
import { eq, and, or, asc, desc, gte, lte, isNull, count, inArray, sql } from 'drizzle-orm'
import { db } from '../db'
import {
  jornada, estadisticaJornada, snapshotAlineacion, puntuacionJornada, penalizacionJornada,
  miembroLiga, liga, jugador, jugadorEquipo, equipo, titularLiga, configPuntuacion, configEconomia, configRevalorizacion,
  plantillaFantasy, clausulazoPendiente, transferencia, usuario,
  Division, Posicion, AccionPuntuacion, ResultadoPartido, MotivoPenalizacion,
} from '../db/schema'
import { registrarAccion } from '../lib/registrarAccion'
import { registrarCambioValor, registrarCambioClausula } from '../lib/historial'

// ─── HELPERS ───────────────────────────────────────

function rand(min: number, max: number) { return Math.floor(Math.random() * (max - min + 1)) + min }
function prob(p: number)                { return Math.random() < p }

function getPuntos(config: { posicion: Posicion | null; accion: AccionPuntuacion; puntos: number }[], accion: AccionPuntuacion, posicion: Posicion): number {
  return config.find(c => c.accion === accion && c.posicion === posicion)?.puntos
    ?? config.find(c => c.accion === accion && c.posicion === null)?.puntos ?? 0
}

interface StatsParaPuntos {
  convocado: boolean; titular: boolean; minutosJugados: number
  goles: number; golesDePenalti: number; golEnPropia: number
  golesAFavor: number; golesEncajados: number
  diferenciaGoles: number
  tarjetasAmarillas: number; tarjetaRoja: boolean
  resultado: ResultadoPartido
}

function calcularPuntos(stats: StatsParaPuntos, posicion: Posicion, config: { posicion: Posicion | null; accion: AccionPuntuacion; puntos: number }[]) {
  const get = (accion: AccionPuntuacion) =>
    getPuntos(config, accion, posicion)

  const d: Record<string, unknown> = {}
  let total = 0

  const golesNormales = stats.goles - stats.golesDePenalti

  if (stats.convocado)                 { const p = get('CONVOCADO');       d.convocado   = p; total += p }
  if (stats.minutosJugados > 0)        { const p = get('JUEGA');           d.juega       = p; total += p }
  if (stats.titular)                   { const p = get('TITULAR');         d.titular     = p; total += p }
  if (stats.minutosJugados > 60)       { const p = get('MINUTOS_60');      d.minutos60   = p; total += p }

  if (golesNormales > 0)               { const u = get('GOL');             const t = u * golesNormales;          d.goles         = { cantidad: golesNormales,          puntosUnitarios: u, total: t }; total += t }
  if (stats.golesDePenalti > 0)        { const u = get('GOL_PENALTY');     const t = u * stats.golesDePenalti;   d.golesPenalty  = { cantidad: stats.golesDePenalti,   puntosUnitarios: u, total: t }; total += t }
  if (stats.golEnPropia > 0)           { const u = get('GOL_PROPIA');      const t = u * stats.golEnPropia;      d.golEnPropia   = { cantidad: stats.golEnPropia,      puntosUnitarios: u, total: t }; total += t }
  if (stats.golesAFavor > 0)           { const u = get('GOL_A_FAVOR');     const t = u * stats.golesAFavor;      d.golesAFavor   = { cantidad: stats.golesAFavor,      puntosUnitarios: u, total: t }; total += t }
  if (stats.golesEncajados > 0)        { const u = get('GOL_ENCAJADO');    const t = u * stats.golesEncajados;   d.golesEncajados= { cantidad: stats.golesEncajados,   puntosUnitarios: u, total: t }; total += t }

  const accionRes: AccionPuntuacion = stats.resultado === 'VICTORIA' ? 'VICTORIA' : stats.resultado === 'EMPATE' ? 'EMPATE' : 'DERROTA'
  const pRes = get(accionRes); d.resultado = { tipo: stats.resultado, puntos: pRes }; total += pRes

  if (stats.diferenciaGoles > 3)       { const p = get('GOLEADA_FAVOR');   d.goleadaFavor  = p; total += p }
  if (stats.diferenciaGoles < -3)      { const p = get('GOLEADA_CONTRA');  d.goleadaContra = p; total += p }

  if (stats.tarjetasAmarillas >= 2)    { const p = get('DOBLE_AMARILLA');  d.dobleAmarilla  = p; total += p }
  else if (stats.tarjetasAmarillas > 0){ const p = get('TARJETA_AMARILLA');d.tarjetaAmarilla= p; total += p }
  if (stats.tarjetaRoja)               { const p = get('TARJETA_ROJA');    d.tarjetaRoja    = p; total += p }

  return { total, desglose: d }
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

export const editarJornada = async (req: AuthRequest, res: Response) => {
  const jornadaId = req.params.jornadaId as string
  const { fechaCierre, fechaImportacion } = req.body

  try {
    const [j] = await db.select().from(jornada).where(eq(jornada.id, jornadaId)).limit(1)
    if (!j) { res.status(404).json({ error: 'Jornada no encontrada' }); return }

    const set: { fechaCierre?: Date; fechaImportacion?: Date | null } = {}
    if (fechaCierre !== undefined)      set.fechaCierre      = new Date(fechaCierre)
    if (fechaImportacion !== undefined) set.fechaImportacion = fechaImportacion ? new Date(fechaImportacion) : null

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
      const { total, desglose } = calcularPuntos(
        { convocado, titular, minutosJugados, goles, golesDePenalti: 0, golEnPropia: 0, golesAFavor: 0, golesEncajados: 0, diferenciaGoles: 0, tarjetasAmarillas, tarjetaRoja, resultado },
        je.jugador.posicion, config,
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

// ─── REVALORIZACIÓN ────────────────────────────────

interface TramoReval { puntosHasta: number | null; porcentaje: number }

const DEFAULTS_REVALORIZACION: TramoReval[] = [
  { puntosHasta: 0,    porcentaje: -8 },
  { puntosHasta: 4,    porcentaje: -5 },
  { puntosHasta: 8,    porcentaje: -2 },
  { puntosHasta: 12,   porcentaje:  3 },
  { puntosHasta: 17,   porcentaje:  7 },
  { puntosHasta: null, porcentaje: 12 },
]

async function cargarConfigRevalorizacion(): Promise<TramoReval[]> {
  const rows = await db.select().from(configRevalorizacion).orderBy(asc(configRevalorizacion.orden))
  if (rows.length === 0) return DEFAULTS_REVALORIZACION
  return rows.map(r => ({ puntosHasta: r.puntosHasta ?? null, porcentaje: r.porcentaje }))
}

function pctRevalorizacion(puntos: number, tramos: TramoReval[]): number {
  for (const t of tramos) {
    if (t.puntosHasta === null || puntos <= t.puntosHasta) return t.porcentaje
  }
  return tramos[tramos.length - 1]?.porcentaje ?? 0
}

const VALOR_MINIMO = 1_000_000
const REDONDEO     =   100_000

function revalorizar(valorActual: number, puntos: number, tramos: TramoReval[]): number {
  const pct        = pctRevalorizacion(puntos, tramos)
  const nuevoRaw   = valorActual * (1 + pct / 100)
  const redondeado = Math.round(nuevoRaw / REDONDEO) * REDONDEO
  return Math.max(VALOR_MINIMO, redondeado)
}

// ─── CALCULAR PUNTOS POR JUGADOR ──────────────────

export const calcularPuntosPorJugador = async (req: AuthRequest, res: Response) => {
  const jornadaId = req.params.jornadaId as string

  try {
    const [j] = await db.select().from(jornada).where(eq(jornada.id, jornadaId)).limit(1)
    if (!j) { res.status(404).json({ error: 'Jornada no encontrada' }); return }

    const config = await db.select().from(configPuntuacion).where(
      and(eq(configPuntuacion.activo, true), lte(configPuntuacion.desde, j.fechaCierre),
          or(isNull(configPuntuacion.hasta), gte(configPuntuacion.hasta, j.fechaCierre)))
    )

    const tramosReval = await cargarConfigRevalorizacion()

    const rows = await db
      .select({
        est:          estadisticaJornada,
        posicion:     jugador.posicion,
        jugadorId:    jugador.id,
        valorActual:  jugador.valor,
      })
      .from(estadisticaJornada)
      .innerJoin(jugadorEquipo, eq(jugadorEquipo.id, estadisticaJornada.jugadorEquipoId))
      .innerJoin(jugador, eq(jugador.id, jugadorEquipo.jugadorId))
      .where(eq(estadisticaJornada.jornadaId, jornadaId))

    let actualizados = 0
    const jugadoresActualizados = new Set<string>()

    for (const { est, posicion, jugadorId, valorActual } of rows) {
      const { total, desglose } = calcularPuntos(
        {
          convocado:         est.convocado,
          titular:           est.titular,
          minutosJugados:    est.minutosJugados,
          goles:             est.goles,
          golesDePenalti:    est.golesDePenalti,
          golEnPropia:       est.golEnPropia,
          golesAFavor:       est.golesAFavor,
          golesEncajados:    est.golesEncajados,
          diferenciaGoles:   est.diferenciaGoles,
          tarjetasAmarillas: est.tarjetasAmarillas,
          tarjetaRoja:       est.tarjetaRoja,
          resultado:         est.resultado,
        },
        posicion,
        config,
      )
      await db.update(estadisticaJornada)
        .set({ puntosCalculados: total, desglose: desglose as any })
        .where(eq(estadisticaJornada.id, est.id))

      // Revalorizar solo una vez por jugador (puede tener varios jugadorEquipo)
      if (!jugadoresActualizados.has(jugadorId)) {
        const nuevoValor = revalorizar(valorActual, total, tramosReval)
        if (nuevoValor !== valorActual) {
          await db.update(jugador).set({ valor: nuevoValor }).where(eq(jugador.id, jugadorId))
          await registrarCambioValor({ jugadorId, valorAnterior: valorActual, valorNuevo: nuevoValor, numJornada: j.numJornada })
        }
        jugadoresActualizados.add(jugadorId)
      }

      actualizados++
    }

    await db.update(jornada).set({ puntosPorJugadorCalculados: true }).where(eq(jornada.id, jornadaId))
    await registrarAccion(req.usuarioId!, 'CALCULAR_PUNTUACIONES', 'Jornada', jornadaId, { jornadaId, actualizados })
    res.json({ mensaje: `Puntos calculados para ${actualizados} jugadores`, jornadaId })
  } catch (e: any) {
    res.status(500).json({ error: e.message ?? 'Error al calcular puntos' })
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

    // Contar jugadores en alineación por miembro
    const jugadoresPorMiembro = new Map<string, number>()
    for (const r of titularesRaw) {
      jugadoresPorMiembro.set(r.miembroLigaId, (jugadoresPorMiembro.get(r.miembroLigaId) ?? 0) + 1)
    }

    const miembroMap = new Map(miembros.map(m => [m.id, m]))
    const snapshots: { id: string; jornadaId: string; miembroLigaId: string; jugadorEquipoId: string; esCapitan: boolean; creadoEn: Date }[] = []
    const penalizaciones: { id: string; jornadaId: string; miembroLigaId: string; motivo: MotivoPenalizacion }[] = []
    const penalizadoSet = new Set<string>()
    const seen = new Set<string>()

    for (const miembro of miembros) {
      if (miembro.presupuestoRestante < 0) {
        penalizaciones.push({ id: randomUUID(), jornadaId, miembroLigaId: miembro.id, motivo: 'SALDO_NEGATIVO' })
        penalizadoSet.add(miembro.id)
        await db.update(miembroLiga)
          .set({ puntuacion: sql`${miembroLiga.puntuacion} - 10` })
          .where(eq(miembroLiga.id, miembro.id))
      } else if ((jugadoresPorMiembro.get(miembro.id) ?? 0) < 11) {
        penalizaciones.push({ id: randomUUID(), jornadaId, miembroLigaId: miembro.id, motivo: 'ALINEACION_INCOMPLETA' })
        penalizadoSet.add(miembro.id)
        await db.update(miembroLiga)
          .set({ puntuacion: sql`${miembroLiga.puntuacion} - 10` })
          .where(eq(miembroLiga.id, miembro.id))
      }
    }

    if (penalizaciones.length > 0) await db.insert(penalizacionJornada).ignore().values(penalizaciones)

    // Todos los miembros entran en el snapshot (incluidos penalizados)
    for (const r of titularesRaw) {
      const key = `${r.miembroLigaId}:${r.jugadorId}`
      if (seen.has(key)) continue
      seen.add(key)
      const miembro = miembroMap.get(r.miembroLigaId)
      if (!miembro) continue
      snapshots.push({ id: randomUUID(), jornadaId, miembroLigaId: r.miembroLigaId, jugadorEquipoId: r.jeId, esCapitan: miembro.capitanId === r.jugadorId, creadoEn: new Date() })
    }

    if (snapshots.length > 0) await db.insert(snapshotAlineacion).ignore().values(snapshots)
    await db.update(jornada).set({ snapshotGenerado: true }).where(eq(jornada.id, jornadaId))
    await registrarAccion(req.usuarioId!, 'GENERAR_SNAPSHOT', 'Jornada', jornadaId, { jornadaId, total: snapshots.length, penalizados: penalizaciones.length })

    const resumen = penalizaciones.reduce((acc, p) => {
      acc[p.motivo] = (acc[p.motivo] ?? 0) + 1
      return acc
    }, {} as Record<string, number>)
    const detalles = Object.entries(resumen).map(([m, n]) => `${n} por ${m.toLowerCase().replace('_', ' ')}`).join(', ')
    res.json({ mensaje: `Snapshot generado: ${snapshots.length} entradas${penalizaciones.length ? ` · Penalizados (-10 pts): ${detalles}` : ''}`, jornadaId })
  } catch (e: any) {
    res.status(500).json({ error: e.message ?? 'Error al generar snapshot' })
  }
}

// ─── INGRESOS POR JORNADA ──────────────────────────

const DEFAULTS_ECONOMIA: Record<string, number> = {
  INGRESO_FIJO:      500_000,
  INGRESO_POR_PUNTO:  50_000,
  BONUS_P1:        3_000_000,
  BONUS_P2:        2_000_000,
  BONUS_P3:        1_500_000,
  BONUS_P4:        1_000_000,
  BONUS_P5:          500_000,
}

async function cargarConfigEconomia(): Promise<Record<string, number>> {
  const rows = await db.select().from(configEconomia)
  const cfg = { ...DEFAULTS_ECONOMIA }
  for (const r of rows) cfg[r.clave] = r.valor
  return cfg
}

// ─── CALCULAR PUNTUACIONES ─────────────────────────

export const calcularPuntuaciones = async (req: AuthRequest, res: Response) => {
  const jornadaId = req.params.jornadaId as string

  try {
    const [j] = await db.select().from(jornada).where(eq(jornada.id, jornadaId)).limit(1)
    if (!j) { res.status(404).json({ error: 'Jornada no encontrada' }); return }

    const snapshots = await db.select().from(snapshotAlineacion).where(eq(snapshotAlineacion.jornadaId, jornadaId))
    if (snapshots.length === 0) { res.status(409).json({ error: 'No hay snapshots para esta jornada. Genera primero el cierre de jornada.' }); return }

    const eco         = await cargarConfigEconomia()
    const BONUS_POSICION = [eco.BONUS_P1, eco.BONUS_P2, eco.BONUS_P3, eco.BONUS_P4, eco.BONUS_P5]

    const estadisticas  = await db.select().from(estadisticaJornada).where(eq(estadisticaJornada.jornadaId, jornadaId))
    const statsMap      = new Map(estadisticas.map(e => [e.jugadorEquipoId, e]))
    const penalizados   = await db.select().from(penalizacionJornada).where(eq(penalizacionJornada.jornadaId, jornadaId))
    const penalizadoSet = new Set(penalizados.map(p => p.miembroLigaId))

    // Cargar miembroLiga para saber a qué liga pertenece cada miembro
    const miembroIds    = [...new Set(snapshots.map(s => s.miembroLigaId))]
    const miembros      = miembroIds.length > 0
      ? await db.select().from(miembroLiga).where(inArray(miembroLiga.id, miembroIds))
      : []
    const miembroMap    = new Map(miembros.map(m => [m.id, m]))

    // Calcular puntos de jornada por miembro
    const puntosPorMiembro = new Map<string, number>()
    for (const snap of snapshots) {
      if (!puntosPorMiembro.has(snap.miembroLigaId)) puntosPorMiembro.set(snap.miembroLigaId, 0)
    }
    for (const [miembroLigaId] of puntosPorMiembro) {
      if (penalizadoSet.has(miembroLigaId)) continue
      const snaps = snapshots.filter(s => s.miembroLigaId === miembroLigaId)
      const pts   = snaps.reduce((acc, snap) => {
        const stats = statsMap.get(snap.jugadorEquipoId)
        if (!stats) return acc
        return acc + (snap.esCapitan ? stats.puntosCalculados * 2 : stats.puntosCalculados)
      }, 0)
      puntosPorMiembro.set(miembroLigaId, pts)
    }

    // Agrupar miembros por liga y ordenar por puntos para calcular posición
    const porLiga = new Map<string, string[]>()
    for (const [miembroLigaId] of puntosPorMiembro) {
      const m = miembroMap.get(miembroLigaId)
      if (!m) continue
      if (!porLiga.has(m.ligaId)) porLiga.set(m.ligaId, [])
      porLiga.get(m.ligaId)!.push(miembroLigaId)
    }
    // Ordenar cada liga por puntos descendente → asignar bonus por posición
    const bonusPosicion = new Map<string, number>()
    for (const [, ids] of porLiga) {
      ids.sort((a, b) => (puntosPorMiembro.get(b) ?? 0) - (puntosPorMiembro.get(a) ?? 0))
      ids.forEach((id, idx) => bonusPosicion.set(id, BONUS_POSICION[idx] ?? 0))
    }

    // Guardar puntuaciones y aplicar ingresos
    let calculados = 0
    for (const [miembroLigaId, puntos] of puntosPorMiembro) {
      await db.insert(puntuacionJornada)
        .values({ id: randomUUID(), jornadaId, miembroLigaId, puntos })
        .onDuplicateKeyUpdate({ set: { puntos } })

      if (puntos > 0) {
        await db.update(miembroLiga)
          .set({ puntuacion: sql`${miembroLiga.puntuacion} + ${puntos}` })
          .where(eq(miembroLiga.id, miembroLigaId))
      }

      // Ingresos: fijo + por punto + posición (todos reciben el fijo, incluidos penalizados)
      const bonus   = bonusPosicion.get(miembroLigaId) ?? 0
      const ingreso = eco.INGRESO_FIJO + (puntos * eco.INGRESO_POR_PUNTO) + bonus
      await db.update(miembroLiga)
        .set({ presupuestoRestante: sql`${miembroLiga.presupuestoRestante} + ${ingreso}` })
        .where(eq(miembroLiga.id, miembroLigaId))

      calculados++
    }

    // ── Procesar clausulazos pendientes ───────────────
    const ligaIds = [...new Set(miembros.map(m => m.ligaId))]
    if (ligaIds.length > 0) {
      const pendientes = await db.select().from(clausulazoPendiente)
        .where(inArray(clausulazoPendiente.ligaId, ligaIds))

      for (const cp of pendientes) {
        const [plantilla] = await db.select().from(plantillaFantasy)
          .where(and(eq(plantillaFantasy.ligaId, cp.ligaId), eq(plantillaFantasy.jugadorId, cp.jugadorId))).limit(1)
        if (!plantilla || plantilla.miembroLigaId !== cp.vendedorMiembroId) {
          await db.delete(clausulazoPendiente).where(eq(clausulazoPendiente.id, cp.id))
          continue
        }
        await db.transaction(async tx => {
          // Quitar del equipo anterior (y de su 11)
          await tx.delete(titularLiga)
            .where(and(eq(titularLiga.miembroLigaId, cp.vendedorMiembroId), eq(titularLiga.jugadorId, cp.jugadorId)))
          await tx.delete(plantillaFantasy)
            .where(and(eq(plantillaFantasy.ligaId, cp.ligaId), eq(plantillaFantasy.jugadorId, cp.jugadorId)))
          // Añadir al nuevo equipo con bloqueo
          await tx.insert(plantillaFantasy).values({
            id: randomUUID(), ligaId: cp.ligaId, miembroLigaId: cp.compradorMiembroId,
            jugadorId: cp.jugadorId, precioCompra: cp.importe,
            clausula: cp.importe * 2, jornadasBloqueo: 3,
            creadoEn: new Date(),
          })
          // Registrar transferencia
          await tx.insert(transferencia).values({
            id: randomUUID(), jugadorId: cp.jugadorId, ligaId: cp.ligaId,
            vendedorId: cp.vendedorMiembroId, compradorId: cp.compradorMiembroId,
            ofertaId: null, precio: cp.importe, fecha: new Date(),
          })
          await registrarCambioClausula(tx, {
            jugadorId: cp.jugadorId, ligaId: cp.ligaId, miembroLigaId: cp.compradorMiembroId,
            clausulaAnterior: plantilla.clausula, clausulaNueva: cp.importe * 2, motivo: 'CLAUSULAZO_NUEVO_DUENO',
          })
          // Eliminar el pendiente
          await tx.delete(clausulazoPendiente).where(eq(clausulazoPendiente.id, cp.id))
        })
      }

      // Decrementar jornadasBloqueo para todos los jugadores de las ligas procesadas
      await db.update(plantillaFantasy)
        .set({ jornadasBloqueo: sql`GREATEST(${plantillaFantasy.jornadasBloqueo} - 1, 0)` })
        .where(and(inArray(plantillaFantasy.ligaId, ligaIds), sql`${plantillaFantasy.jornadasBloqueo} > 0`))
    }

    await db.update(jornada).set({ puntuacionesCalculadas: true }).where(eq(jornada.id, jornadaId))
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
