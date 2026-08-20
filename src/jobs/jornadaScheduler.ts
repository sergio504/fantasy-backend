import { and, eq, isNotNull, lte } from 'drizzle-orm'
import { db } from '../db'
import { jornada } from '../db/schema'
import { generarSnapshotOp, calcularPuntosPorJugadorOp, calcularPuntuacionesOp } from '../lib/jornadaOps'

export async function ejecutarJobsJornada() {
  const ahora = new Date()

  // ── Job 1: Snapshot ─────────────────────────────────────────
  // Cuando fechaInicioJornada ha pasado y aún no se ha generado snapshot
  const parSnapshot = await db
    .select({ id: jornada.id, division: jornada.division, numJornada: jornada.numJornada })
    .from(jornada)
    .where(and(
      isNotNull(jornada.fechaInicioJornada),
      lte(jornada.fechaInicioJornada, ahora),
      eq(jornada.snapshotGenerado, false),
    ))

  for (const j of parSnapshot) {
    try {
      const msg = await generarSnapshotOp(j.id)
      console.log(`[JOB] Snapshot J${j.numJornada} (${j.division}): ${msg}`)
    } catch (e: any) {
      console.error(`[JOB] Error snapshot J${j.numJornada} (${j.division}): ${e.message}`)
    }
  }

  // Job 2 (scraper + importación automática) eliminado: las estadísticas
  // se suben a mano vía POST /api/jornadas/:jornadaId/importar, que ya
  // marca `statsImportadas = true` y deja que el Job 3 siga solo desde ahí.

  // ── Job 3: Puntos por jugador ────────────────────────────────
  // Cuando fechaFinJornada ha pasado, stats importadas y puntos sin calcular
  const parPuntos = await db
    .select({ id: jornada.id, division: jornada.division, numJornada: jornada.numJornada })
    .from(jornada)
    .where(and(
      isNotNull(jornada.fechaFinJornada),
      lte(jornada.fechaFinJornada, ahora),
      eq(jornada.statsImportadas, true),
      eq(jornada.puntosPorJugadorCalculados, false),
    ))

  for (const j of parPuntos) {
    try {
      const msg = await calcularPuntosPorJugadorOp(j.id)
      console.log(`[JOB] Puntos jugador J${j.numJornada} (${j.division}): ${msg}`)
    } catch (e: any) {
      console.error(`[JOB] Error puntos J${j.numJornada} (${j.division}): ${e.message}`)
    }
  }

  // ── Job 4: Puntuaciones de equipos ──────────────────────────
  // Cuando puntos por jugador calculados y puntuaciones de equipos pendientes
  const parPuntuaciones = await db
    .select({ id: jornada.id, division: jornada.division, numJornada: jornada.numJornada })
    .from(jornada)
    .where(and(
      isNotNull(jornada.fechaFinJornada),
      lte(jornada.fechaFinJornada, ahora),
      eq(jornada.puntosPorJugadorCalculados, true),
      eq(jornada.puntuacionesCalculadas, false),
    ))

  for (const j of parPuntuaciones) {
    try {
      const msg = await calcularPuntuacionesOp(j.id)
      console.log(`[JOB] Puntuaciones J${j.numJornada} (${j.division}): ${msg}`)
    } catch (e: any) {
      console.error(`[JOB] Error puntuaciones J${j.numJornada} (${j.division}): ${e.message}`)
    }
  }
}
