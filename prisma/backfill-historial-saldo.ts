import { drizzle } from 'drizzle-orm/mysql2'
import { eq, and, asc } from 'drizzle-orm'
import mysql from 'mysql2/promise'
import * as schema from '../src/db/schema'
import { cargarConfigEconomia } from '../src/lib/jornadaOps'
import { registrarMovimientoSaldo } from '../src/lib/historial'
import dotenv from 'dotenv'

dotenv.config()

// Reconstruye en historialSaldo el ingreso de jornada que ya se aplicó a
// presupuestoRestante antes de que existiera el registro (INGRESO_JORNADA se
// añadió después de que la jornada 1 se calculara). Recorre las jornadas ya
// calculadas en orden, recalcula el mismo ingreso que calcularPuntuacionesOp,
// y solo inserta la fila si todavía no existe (idempotente).
async function main() {
  const pool = mysql.createPool({ uri: process.env.DATABASE_URL! })
  const db = drizzle(pool, { schema, mode: 'default' })

  const eco = await cargarConfigEconomia()
  const BONUS_POSICION = [eco.BONUS_P1, eco.BONUS_P2, eco.BONUS_P3, eco.BONUS_P4, eco.BONUS_P5]

  const jornadasProcesadas = await db.select().from(schema.jornada)
    .where(eq(schema.jornada.puntuacionesCalculadas, true))
    .orderBy(asc(schema.jornada.numJornada))

  const ligas    = await db.select().from(schema.liga)
  const miembros = await db.select().from(schema.miembroLiga)
  const miembroMap = new Map(miembros.map(m => [m.id, m]))
  const presupuestoInicialPorLiga = new Map(ligas.map(l => [l.id, l.presupuestoInicial]))

  const saldoAcumulado = new Map<string, number>()
  for (const m of miembros) saldoAcumulado.set(m.id, presupuestoInicialPorLiga.get(m.ligaId) ?? 100)

  let insertados = 0
  for (const j of jornadasProcesadas) {
    const puntuaciones = await db.select().from(schema.puntuacionJornada).where(eq(schema.puntuacionJornada.jornadaId, j.id))
    if (puntuaciones.length === 0) continue

    const porLiga = new Map<string, { miembroLigaId: string; puntos: number }[]>()
    for (const p of puntuaciones) {
      const m = miembroMap.get(p.miembroLigaId)
      if (!m) continue
      if (!porLiga.has(m.ligaId)) porLiga.set(m.ligaId, [])
      porLiga.get(m.ligaId)!.push({ miembroLigaId: p.miembroLigaId, puntos: p.puntos })
    }
    const bonusPorMiembro = new Map<string, number>()
    for (const [, lista] of porLiga) {
      lista.sort((a, b) => b.puntos - a.puntos)
      lista.forEach((x, idx) => bonusPorMiembro.set(x.miembroLigaId, BONUS_POSICION[idx] ?? 0))
    }

    for (const p of puntuaciones) {
      const m = miembroMap.get(p.miembroLigaId)
      if (!m) continue

      const bonus   = bonusPorMiembro.get(p.miembroLigaId) ?? 0
      const ingreso = Math.round(eco.INGRESO_FIJO + (p.puntos * eco.INGRESO_POR_PUNTO) + bonus)
      const nuevoSaldo = (saldoAcumulado.get(p.miembroLigaId) ?? 0) + ingreso
      saldoAcumulado.set(p.miembroLigaId, nuevoSaldo)

      const yaExiste = await db.select({ id: schema.historialSaldo.id }).from(schema.historialSaldo)
        .where(and(
          eq(schema.historialSaldo.miembroLigaId, p.miembroLigaId),
          eq(schema.historialSaldo.concepto, 'INGRESO_JORNADA'),
          eq(schema.historialSaldo.numJornada, j.numJornada),
        )).limit(1)
      if (yaExiste.length > 0) continue

      await registrarMovimientoSaldo(db, {
        miembroLigaId: p.miembroLigaId, ligaId: m.ligaId, concepto: 'INGRESO_JORNADA',
        importe: ingreso, saldoResultante: nuevoSaldo,
        descripcion: `Ingreso jornada ${j.numJornada} (${p.puntos} pts${bonus ? ` + ${bonus} bono` : ''}) — recuperado`,
        numJornada: j.numJornada,
      })
      insertados++
    }
  }

  console.log(`✓ ${insertados} movimientos de saldo reconstruidos.`)

  let incoherencias = 0
  for (const m of miembros) {
    const esperado = saldoAcumulado.get(m.id) ?? 0
    if (esperado !== m.presupuestoRestante) {
      incoherencias++
      console.warn(`  [!] Miembro ${m.id} (liga ${m.ligaId}): reconstruido=${esperado}, actual en BD=${m.presupuestoRestante} — hay otra actividad de saldo no contemplada aquí (mercado, cláusulas...)`)
    }
  }
  if (incoherencias === 0) console.log('✓ El saldo reconstruido coincide con presupuestoRestante para todos los miembros.')

  await pool.end()
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
