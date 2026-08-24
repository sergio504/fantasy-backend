import { drizzle } from 'drizzle-orm/mysql2'
import { eq } from 'drizzle-orm'
import mysql from 'mysql2/promise'
import * as schema from '../src/db/schema'
import dotenv from 'dotenv'

dotenv.config()

// Reset: borra ligas, mercado, jornadas/estadísticas, plantillas fantasy,
// históricos y usuarios no-admin. Mantiene: jugador, equipo, jugadorEquipo,
// divisiones, aliasEquipo, aliasJugador, config* y el/los usuario(s) con
// esAdmin = true.
async function main() {
  const pool = mysql.createPool({ uri: process.env.DATABASE_URL! })
  const db = drizzle(pool, { schema, mode: 'default' })

  console.log('🧹 Borrando todo excepto jugadores, configuración y el usuario admin...')

  await db.transaction(async tx => {
    await tx.delete(schema.puntuacionJornada)
    await tx.delete(schema.estadisticaJornada)
    await tx.delete(schema.estadisticaJornadaSinRegistrar)
    await tx.delete(schema.snapshotAlineacion)
    await tx.delete(schema.penalizacionJornada)
    await tx.delete(schema.jornada)
    await tx.delete(schema.puja)
    await tx.delete(schema.transferencia)
    await tx.delete(schema.ofertaMercado)
    await tx.delete(schema.clausulazoPendiente)
    await tx.delete(schema.titularLiga)
    await tx.delete(schema.plantillaFantasy)
    await tx.delete(schema.historialAdmin)
    await tx.delete(schema.historialSaldo)
    await tx.delete(schema.historialValorJugador)
    await tx.delete(schema.historialClausula)
    await tx.delete(schema.historialConfig)
    await tx.delete(schema.miembroLiga)
    await tx.delete(schema.liga)
    await tx.delete(schema.usuario).where(eq(schema.usuario.esAdmin, false))
  })

  console.log('✓ Borrado completo.')
  console.log('  Se mantienen: jugador, equipo, jugadorEquipo, divisiones, aliasEquipo, aliasJugador, config*, usuario(s) admin.')

  await pool.end()
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
