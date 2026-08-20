import { drizzle } from 'drizzle-orm/mysql2'
import { eq } from 'drizzle-orm'
import mysql from 'mysql2/promise'
import * as schema from '../src/db/schema'
import dotenv from 'dotenv'

dotenv.config()

// Borra jornadas, estadísticas, mercado, plantillas fantasy e históricos.
// Mantiene: usuario, liga, miembroLiga (reseteado), equipo, jugador,
// jugadorEquipo, divisiones, aliasEquipo, aliasJugador y config*.
async function main() {
  const pool = mysql.createPool({ uri: process.env.DATABASE_URL! })
  const db = drizzle(pool, { schema, mode: 'default' })

  console.log('🧹 Borrando jornadas, estadísticas, mercado y plantillas...')

  await db.transaction(async tx => {
    // Jornadas y todo lo que cuelga de ellas
    await tx.delete(schema.puntuacionJornada)
    await tx.delete(schema.estadisticaJornada)
    await tx.delete(schema.estadisticaJornadaSinRegistrar)
    await tx.delete(schema.snapshotAlineacion)
    await tx.delete(schema.penalizacionJornada)
    await tx.delete(schema.jornada)

    // Mercado y fichajes
    await tx.delete(schema.puja)
    await tx.delete(schema.transferencia)
    await tx.delete(schema.ofertaMercado)
    await tx.delete(schema.clausulazoPendiente)

    // Plantillas fantasy y alineaciones titulares
    await tx.delete(schema.titularLiga)
    await tx.delete(schema.plantillaFantasy)

    // Históricos
    await tx.delete(schema.historialAdmin)
    await tx.delete(schema.historialSaldo)
    await tx.delete(schema.historialValorJugador)
    await tx.delete(schema.historialClausula)
    await tx.delete(schema.historialConfig)

    // Reset de presupuesto/puntuación/capitán por miembro de liga
    const miembros = await tx.select({ id: schema.miembroLiga.id, ligaId: schema.miembroLiga.ligaId })
      .from(schema.miembroLiga)
    const ligas = await tx.select({ id: schema.liga.id, presupuestoInicial: schema.liga.presupuestoInicial })
      .from(schema.liga)
    const presupuestoPorLiga = new Map(ligas.map(l => [l.id, l.presupuestoInicial]))

    for (const m of miembros) {
      await tx.update(schema.miembroLiga)
        .set({
          presupuestoRestante: presupuestoPorLiga.get(m.ligaId) ?? 100,
          puntuacion: 0,
          capitanId: null,
        })
        .where(eq(schema.miembroLiga.id, m.id))
    }
  })

  console.log('✓ Reset completado.')
  console.log('  Se mantienen: usuarios, ligas, miembros de liga (presupuesto/puntos reseteados), equipos, jugadores y configuración.')

  await pool.end()
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
