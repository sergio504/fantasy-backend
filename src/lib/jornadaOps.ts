import { randomUUID } from 'crypto'
import { eq, and, or, asc, lte, gte, isNull, count, inArray, sql } from 'drizzle-orm'
import { db } from '../db'
import {
  jornada, estadisticaJornada, snapshotAlineacion, puntuacionJornada, penalizacionJornada,
  miembroLiga, liga, jugador, jugadorEquipo, titularLiga,
  configPuntuacion, configEconomia, configRevalorizacion,
  plantillaFantasy, clausulazoPendiente, transferencia,
  Posicion, AccionPuntuacion, ResultadoPartido, MotivoPenalizacion,
} from '../db/schema'
import { registrarAccion } from './registrarAccion'
import { registrarCambioValor, registrarCambioClausula } from './historial'

// ─── CÁLCULO DE PUNTOS ─────────────────────────────

function getPuntos(
  config: { posicion: Posicion | null; accion: AccionPuntuacion; puntos: number }[],
  accion: AccionPuntuacion,
  posicion: Posicion,
): number {
  return config.find(c => c.accion === accion && c.posicion === posicion)?.puntos
    ?? config.find(c => c.accion === accion && c.posicion === null)?.puntos ?? 0
}

export interface StatsParaPuntos {
  convocado: boolean; titular: boolean; minutosJugados: number
  goles: number; golesDePenalti: number; golEnPropia: number
  golesAFavor: number; golesEncajados: number; diferenciaGoles: number
  tarjetasAmarillas: number; tarjetaRoja: boolean
  resultado: ResultadoPartido
}

export function calcularPuntos(
  stats: StatsParaPuntos,
  posicion: Posicion,
  config: { posicion: Posicion | null; accion: AccionPuntuacion; puntos: number }[],
) {
  const get = (a: AccionPuntuacion) => getPuntos(config, a, posicion)
  const d: Record<string, unknown> = {}
  let total = 0
  const golesNormales = stats.goles - stats.golesDePenalti

  if (stats.convocado)                  { const p = get('CONVOCADO');        d.convocado        = p; total += p }
  if (stats.minutosJugados > 0)         { const p = get('JUEGA');            d.juega            = p; total += p }
  if (stats.titular)                    { const p = get('TITULAR');          d.titular          = p; total += p }
  if (stats.minutosJugados > 60)        { const p = get('MINUTOS_60');       d.minutos60        = p; total += p }
  if (golesNormales > 0)                { const u = get('GOL');              const t = u * golesNormales;        d.goles          = { cantidad: golesNormales,        puntosUnitarios: u, total: t }; total += t }
  if (stats.golesDePenalti > 0)         { const u = get('GOL_PENALTY');      const t = u * stats.golesDePenalti; d.golesPenalty   = { cantidad: stats.golesDePenalti,  puntosUnitarios: u, total: t }; total += t }
  if (stats.golEnPropia > 0)            { const u = get('GOL_PROPIA');       const t = u * stats.golEnPropia;    d.golEnPropia    = { cantidad: stats.golEnPropia,     puntosUnitarios: u, total: t }; total += t }
  if (stats.golesAFavor > 0)            { const u = get('GOL_A_FAVOR');      const t = u * stats.golesAFavor;    d.golesAFavor    = { cantidad: stats.golesAFavor,     puntosUnitarios: u, total: t }; total += t }
  if (stats.golesEncajados > 0)         { const u = get('GOL_ENCAJADO');     const t = u * stats.golesEncajados; d.golesEncajados = { cantidad: stats.golesEncajados,  puntosUnitarios: u, total: t }; total += t }

  const accionRes: AccionPuntuacion = stats.resultado === 'VICTORIA' ? 'VICTORIA' : stats.resultado === 'EMPATE' ? 'EMPATE' : 'DERROTA'
  const pRes = get(accionRes); d.resultado = { tipo: stats.resultado, puntos: pRes }; total += pRes

  if (stats.diferenciaGoles > 3)        { const p = get('GOLEADA_FAVOR');    d.goleadaFavor  = p; total += p }
  if (stats.diferenciaGoles < -3)       { const p = get('GOLEADA_CONTRA');   d.goleadaContra = p; total += p }
  if (stats.tarjetasAmarillas >= 2)     { const p = get('DOBLE_AMARILLA');   d.dobleAmarilla  = p; total += p }
  else if (stats.tarjetasAmarillas > 0) { const p = get('TARJETA_AMARILLA'); d.tarjetaAmarilla= p; total += p }
  if (stats.tarjetaRoja)                { const p = get('TARJETA_ROJA');     d.tarjetaRoja    = p; total += p }

  return { total, desglose: d }
}

// ─── CONFIG ────────────────────────────────────────

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

const DEFAULTS_ECONOMIA: Record<string, number> = {
  INGRESO_FIJO:      500_000,
  INGRESO_POR_PUNTO:  50_000,
  BONUS_P1:        3_000_000,
  BONUS_P2:        2_000_000,
  BONUS_P3:        1_500_000,
  BONUS_P4:        1_000_000,
  BONUS_P5:          500_000,
}

export async function cargarConfigEconomia(): Promise<Record<string, number>> {
  const rows = await db.select().from(configEconomia)
  const cfg = { ...DEFAULTS_ECONOMIA }
  for (const r of rows) cfg[r.clave] = r.valor
  return cfg
}

// ─── OPERACIONES ───────────────────────────────────

export async function generarSnapshotOp(jornadaId: string, adminId?: string): Promise<string> {
  const [j] = await db.select().from(jornada).where(eq(jornada.id, jornadaId)).limit(1)
  if (!j) throw new Error('Jornada no encontrada')

  const [{ total: yaExiste }] = await db.select({ total: count() }).from(snapshotAlineacion).where(eq(snapshotAlineacion.jornadaId, jornadaId))
  if (yaExiste > 0) throw new Error('Esta jornada ya tiene snapshot generado')

  const ligas = await db.select({ id: liga.id }).from(liga).where(eq(liga.division, j.division))
  const ligaIds = ligas.map(l => l.id)
  if (ligaIds.length === 0) return 'No hay ligas en esta división'

  const miembros   = await db.select().from(miembroLiga).where(inArray(miembroLiga.ligaId, ligaIds))
  const miembroIds = miembros.map(m => m.id)

  const titularesRaw = miembroIds.length > 0
    ? await db
        .select({ miembroLigaId: titularLiga.miembroLigaId, jugadorId: titularLiga.jugadorId, jeId: jugadorEquipo.id })
        .from(titularLiga)
        .innerJoin(jugadorEquipo, and(eq(jugadorEquipo.jugadorId, titularLiga.jugadorId), eq(jugadorEquipo.activo, true)))
        .where(inArray(titularLiga.miembroLigaId, miembroIds))
    : []

  const jugadoresPorMiembro = new Map<string, number>()
  for (const r of titularesRaw) {
    jugadoresPorMiembro.set(r.miembroLigaId, (jugadoresPorMiembro.get(r.miembroLigaId) ?? 0) + 1)
  }

  const miembroMap  = new Map(miembros.map(m => [m.id, m]))
  const snapshots:     { id: string; jornadaId: string; miembroLigaId: string; jugadorEquipoId: string; esCapitan: boolean; creadoEn: Date }[] = []
  const penalizaciones: { id: string; jornadaId: string; miembroLigaId: string; motivo: MotivoPenalizacion }[] = []
  const seen = new Set<string>()

  for (const miembro of miembros) {
    if (miembro.presupuestoRestante < 0) {
      penalizaciones.push({ id: randomUUID(), jornadaId, miembroLigaId: miembro.id, motivo: 'SALDO_NEGATIVO' })
      await db.update(miembroLiga).set({ puntuacion: sql`${miembroLiga.puntuacion} - 10` }).where(eq(miembroLiga.id, miembro.id))
    } else if ((jugadoresPorMiembro.get(miembro.id) ?? 0) < 11) {
      penalizaciones.push({ id: randomUUID(), jornadaId, miembroLigaId: miembro.id, motivo: 'ALINEACION_INCOMPLETA' })
      await db.update(miembroLiga).set({ puntuacion: sql`${miembroLiga.puntuacion} - 10` }).where(eq(miembroLiga.id, miembro.id))
    }
  }

  if (penalizaciones.length > 0) await db.insert(penalizacionJornada).ignore().values(penalizaciones)

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
  if (adminId) await registrarAccion(adminId, 'GENERAR_SNAPSHOT', 'Jornada', jornadaId, { jornadaId, total: snapshots.length, penalizados: penalizaciones.length })

  const resumen  = penalizaciones.reduce((acc, p) => { acc[p.motivo] = (acc[p.motivo] ?? 0) + 1; return acc }, {} as Record<string, number>)
  const detalles = Object.entries(resumen).map(([m, n]) => `${n} por ${m.toLowerCase().replace('_', ' ')}`).join(', ')
  return `Snapshot generado: ${snapshots.length} entradas${penalizaciones.length ? ` · Penalizados (-10 pts): ${detalles}` : ''}`
}

export async function calcularPuntosPorJugadorOp(jornadaId: string, adminId?: string): Promise<string> {
  const [j] = await db.select().from(jornada).where(eq(jornada.id, jornadaId)).limit(1)
  if (!j) throw new Error('Jornada no encontrada')

  const config = await db.select().from(configPuntuacion).where(
    and(
      eq(configPuntuacion.activo, true),
      lte(configPuntuacion.desde, j.fechaInicioJornada ?? new Date()),
      or(isNull(configPuntuacion.hasta), gte(configPuntuacion.hasta, j.fechaInicioJornada ?? new Date())),
    )
  )

  const tramosReval = await cargarConfigRevalorizacion()

  const rows = await db
    .select({ est: estadisticaJornada, posicion: jugador.posicion, jugadorId: jugador.id, valorActual: jugador.valor })
    .from(estadisticaJornada)
    .innerJoin(jugadorEquipo, eq(jugadorEquipo.id, estadisticaJornada.jugadorEquipoId))
    .innerJoin(jugador,       eq(jugador.id, jugadorEquipo.jugadorId))
    .where(eq(estadisticaJornada.jornadaId, jornadaId))

  let actualizados = 0
  const jugadoresActualizados = new Set<string>()

  for (const { est, posicion, jugadorId, valorActual } of rows) {
    const { total, desglose } = calcularPuntos(
      {
        convocado: est.convocado, titular: est.titular, minutosJugados: est.minutosJugados,
        goles: est.goles, golesDePenalti: est.golesDePenalti, golEnPropia: est.golEnPropia,
        golesAFavor: est.golesAFavor, golesEncajados: est.golesEncajados, diferenciaGoles: est.diferenciaGoles,
        tarjetasAmarillas: est.tarjetasAmarillas, tarjetaRoja: est.tarjetaRoja, resultado: est.resultado,
      },
      posicion, config,
    )
    await db.update(estadisticaJornada).set({ puntosCalculados: total, desglose: desglose as any }).where(eq(estadisticaJornada.id, est.id))

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
  if (adminId) await registrarAccion(adminId, 'CALCULAR_PUNTUACIONES', 'Jornada', jornadaId, { jornadaId, actualizados })
  return `Puntos calculados para ${actualizados} jugadores`
}

export async function calcularPuntuacionesOp(jornadaId: string, adminId?: string): Promise<string> {
  const [j] = await db.select().from(jornada).where(eq(jornada.id, jornadaId)).limit(1)
  if (!j) throw new Error('Jornada no encontrada')

  const snapshots = await db.select().from(snapshotAlineacion).where(eq(snapshotAlineacion.jornadaId, jornadaId))
  if (snapshots.length === 0) throw new Error('No hay snapshots para esta jornada. Genera primero el cierre de jornada.')

  const eco = await cargarConfigEconomia()
  const BONUS_POSICION = [eco.BONUS_P1, eco.BONUS_P2, eco.BONUS_P3, eco.BONUS_P4, eco.BONUS_P5]

  const estadisticas  = await db.select().from(estadisticaJornada).where(eq(estadisticaJornada.jornadaId, jornadaId))
  const statsMap      = new Map(estadisticas.map(e => [e.jugadorEquipoId, e]))
  const penalizados   = await db.select().from(penalizacionJornada).where(eq(penalizacionJornada.jornadaId, jornadaId))
  const penalizadoSet = new Set(penalizados.map(p => p.miembroLigaId))

  const miembroIds = [...new Set(snapshots.map(s => s.miembroLigaId))]
  const miembros   = miembroIds.length > 0 ? await db.select().from(miembroLiga).where(inArray(miembroLiga.id, miembroIds)) : []
  const miembroMap = new Map(miembros.map(m => [m.id, m]))

  const puntosPorMiembro = new Map<string, number>()
  for (const snap of snapshots) {
    if (!puntosPorMiembro.has(snap.miembroLigaId)) puntosPorMiembro.set(snap.miembroLigaId, 0)
  }
  for (const [miembroLigaId] of puntosPorMiembro) {
    if (penalizadoSet.has(miembroLigaId)) continue
    const pts = snapshots
      .filter(s => s.miembroLigaId === miembroLigaId)
      .reduce((acc, snap) => {
        const stats = statsMap.get(snap.jugadorEquipoId)
        if (!stats) return acc
        return acc + (snap.esCapitan ? stats.puntosCalculados * 2 : stats.puntosCalculados)
      }, 0)
    puntosPorMiembro.set(miembroLigaId, pts)
  }

  const porLiga = new Map<string, string[]>()
  for (const [miembroLigaId] of puntosPorMiembro) {
    const m = miembroMap.get(miembroLigaId)
    if (!m) continue
    if (!porLiga.has(m.ligaId)) porLiga.set(m.ligaId, [])
    porLiga.get(m.ligaId)!.push(miembroLigaId)
  }
  const bonusPosicion = new Map<string, number>()
  for (const [, ids] of porLiga) {
    ids.sort((a, b) => (puntosPorMiembro.get(b) ?? 0) - (puntosPorMiembro.get(a) ?? 0))
    ids.forEach((id, idx) => bonusPosicion.set(id, BONUS_POSICION[idx] ?? 0))
  }

  let calculados = 0
  for (const [miembroLigaId, puntos] of puntosPorMiembro) {
    await db.insert(puntuacionJornada).values({ id: randomUUID(), jornadaId, miembroLigaId, puntos }).onDuplicateKeyUpdate({ set: { puntos } })
    if (puntos > 0) await db.update(miembroLiga).set({ puntuacion: sql`${miembroLiga.puntuacion} + ${puntos}` }).where(eq(miembroLiga.id, miembroLigaId))

    const bonus   = bonusPosicion.get(miembroLigaId) ?? 0
    const ingreso = eco.INGRESO_FIJO + (puntos * eco.INGRESO_POR_PUNTO) + bonus
    await db.update(miembroLiga).set({ presupuestoRestante: sql`${miembroLiga.presupuestoRestante} + ${ingreso}` }).where(eq(miembroLiga.id, miembroLigaId))
    calculados++
  }

  const ligaIds = [...new Set(miembros.map(m => m.ligaId))]
  if (ligaIds.length > 0) {
    const pendientes = await db.select().from(clausulazoPendiente).where(inArray(clausulazoPendiente.ligaId, ligaIds))

    for (const cp of pendientes) {
      const [plantilla] = await db.select().from(plantillaFantasy)
        .where(and(eq(plantillaFantasy.ligaId, cp.ligaId), eq(plantillaFantasy.jugadorId, cp.jugadorId))).limit(1)
      if (!plantilla || plantilla.miembroLigaId !== cp.vendedorMiembroId) {
        await db.delete(clausulazoPendiente).where(eq(clausulazoPendiente.id, cp.id))
        continue
      }
      await db.transaction(async tx => {
        await tx.delete(titularLiga).where(and(eq(titularLiga.miembroLigaId, cp.vendedorMiembroId), eq(titularLiga.jugadorId, cp.jugadorId)))
        await tx.delete(plantillaFantasy).where(and(eq(plantillaFantasy.ligaId, cp.ligaId), eq(plantillaFantasy.jugadorId, cp.jugadorId)))
        await tx.insert(plantillaFantasy).values({ id: randomUUID(), ligaId: cp.ligaId, miembroLigaId: cp.compradorMiembroId, jugadorId: cp.jugadorId, precioCompra: cp.importe, clausula: cp.importe * 2, jornadasBloqueo: 3, creadoEn: new Date() })
        await tx.insert(transferencia).values({ id: randomUUID(), jugadorId: cp.jugadorId, ligaId: cp.ligaId, vendedorId: cp.vendedorMiembroId, compradorId: cp.compradorMiembroId, ofertaId: null, precio: cp.importe, fecha: new Date() })
        await registrarCambioClausula(tx, { jugadorId: cp.jugadorId, ligaId: cp.ligaId, miembroLigaId: cp.compradorMiembroId, clausulaAnterior: plantilla.clausula, clausulaNueva: cp.importe * 2, motivo: 'CLAUSULAZO_NUEVO_DUENO' })
        await tx.delete(clausulazoPendiente).where(eq(clausulazoPendiente.id, cp.id))
      })
    }

    await db.update(plantillaFantasy)
      .set({ jornadasBloqueo: sql`GREATEST(${plantillaFantasy.jornadasBloqueo} - 1, 0)` })
      .where(and(inArray(plantillaFantasy.ligaId, ligaIds), sql`${plantillaFantasy.jornadasBloqueo} > 0`))
  }

  await db.update(jornada).set({ puntuacionesCalculadas: true }).where(eq(jornada.id, jornadaId))
  if (adminId) await registrarAccion(adminId, 'CALCULAR_PUNTUACIONES', 'Jornada', jornadaId, { jornadaId, equipos: calculados })
  return `Puntuaciones calculadas para ${calculados} equipos`
}
