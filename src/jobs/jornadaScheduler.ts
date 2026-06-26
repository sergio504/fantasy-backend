import { and, eq, isNotNull, lte } from 'drizzle-orm'
import { db } from '../db'
import { jornada, divisiones } from '../db/schema'
import { generarSnapshotOp, calcularPuntosPorJugadorOp, calcularPuntuacionesOp } from '../lib/jornadaOps'
import { extraerJornada } from '../lib/scraper'
import { importarEstadisticas } from '../lib/importarEstadisticas'

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

  // ── Job 2: Scraper + importación ────────────────────────────
  // Cuando fechaFinJornada ha pasado, snapshot hecho y stats no importadas
  const parScraper = await db
    .select({ id: jornada.id, division: jornada.division, numJornada: jornada.numJornada })
    .from(jornada)
    .where(and(
      isNotNull(jornada.fechaFinJornada),
      lte(jornada.fechaFinJornada, ahora),
      eq(jornada.snapshotGenerado, true),
      eq(jornada.statsImportadas, false),
    ))

  for (const j of parScraper) {
    try {
      const [divInfo] = await db.select().from(divisiones)
        .where(eq(divisiones.division, j.division)).limit(1)

      if (!divInfo) {
        console.error(`[JOB] Sin entrada en divisiones para ${j.division}`)
        continue
      }

      console.log(`[JOB] Scraper J${j.numJornada} (${j.division}): iniciando...`)
      const data = await extraerJornada(divInfo.urlCalendario, j.numJornada)

      if (!data) {
        console.warn(`[JOB] Scraper J${j.numJornada}: sin datos`)
        continue
      }

      const { ok, noEncontrado } = await importarEstadisticas(data, j.division, j.id)
      console.log(`[JOB] Import J${j.numJornada}: ${ok} OK, ${noEncontrado} no encontrados`)
    } catch (e: any) {
      console.error(`[JOB] Error scraper J${j.numJornada} (${j.division}): ${e.message}`)
    }
  }

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
