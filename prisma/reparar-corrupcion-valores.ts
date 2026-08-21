import { drizzle } from 'drizzle-orm/mysql2'
import { eq, gte } from 'drizzle-orm'
import mysql from 'mysql2/promise'
import * as schema from '../src/db/schema'
import dotenv from 'dotenv'

dotenv.config()

// Repara los datos corrompidos por el bug de escala de la economía
// (jugador.valor y miembroLiga.presupuestoRestante en millones en vez de
// la escala pequeña 5-100 que usa el resto del juego). Borra estadísticas,
// jornadas, histórico de valor y puntuaciones; reasigna un valor nuevo
// (5-60) a los jugadores que quedaron clavados en 1.000.000+; resetea
// puntuación y presupuesto de los miembros de liga. Mantiene intactas las
// plantillas fantasy (fichajes) — no hubo transferencias reales con el
// presupuesto inflado.
function randomValor() { return Math.floor(Math.random() * 56) + 5 } // 5-60, igual que importar-jugadores.ts

async function main() {
  const pool = mysql.createPool({ uri: process.env.DATABASE_URL! })
  const db = drizzle(pool, { schema, mode: 'default' })

  console.log('🧹 Borrando estadísticas, jornadas e histórico de valor/puntuación...')

  await db.transaction(async tx => {
    await tx.delete(schema.puntuacionJornada)
    await tx.delete(schema.estadisticaJornada)
    await tx.delete(schema.estadisticaJornadaSinRegistrar)
    await tx.delete(schema.snapshotAlineacion)
    await tx.delete(schema.penalizacionJornada)
    await tx.delete(schema.historialValorJugador)
    await tx.delete(schema.jornada)

    const corruptos = await tx.select({ id: schema.jugador.id })
      .from(schema.jugador).where(gte(schema.jugador.valor, 1_000_000))
    for (const j of corruptos) {
      await tx.update(schema.jugador).set({ valor: randomValor() }).where(eq(schema.jugador.id, j.id))
    }

    const miembros = await tx.select({ id: schema.miembroLiga.id, ligaId: schema.miembroLiga.ligaId }).from(schema.miembroLiga)
    const ligas    = await tx.select({ id: schema.liga.id, presupuestoInicial: schema.liga.presupuestoInicial }).from(schema.liga)
    const presupuestoPorLiga = new Map(ligas.map(l => [l.id, l.presupuestoInicial]))
    for (const m of miembros) {
      await tx.update(schema.miembroLiga)
        .set({ puntuacion: 0, presupuestoRestante: presupuestoPorLiga.get(m.ligaId) ?? 100 })
        .where(eq(schema.miembroLiga.id, m.id))
    }

    console.log(`  ✓ ${corruptos.length} jugadores con valor corrupto reasignado a un nuevo valor 5-60`)
    console.log(`  ✓ ${miembros.length} miembros de liga reseteados (puntuación=0, presupuesto=inicial de su liga)`)
  })

  console.log('✓ Reset completado. Plantillas fantasy (fichajes) intactas.')
  await pool.end()
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
