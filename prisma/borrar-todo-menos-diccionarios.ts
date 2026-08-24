import { drizzle } from 'drizzle-orm/mysql2'
import mysql from 'mysql2/promise'
import * as schema from '../src/db/schema'
import dotenv from 'dotenv'

dotenv.config()

// Reset total: borra todos los datos de usuarios/juego, mantiene solo las
// tablas de configuración/diccionario (divisiones, configPuntuacion,
// configEconomia, configRevalorizacion).
async function main() {
  const pool = mysql.createPool({ uri: process.env.DATABASE_URL! })
  const db = drizzle(pool, { schema, mode: 'default' })

  console.log('🧹 Borrando todo excepto las tablas de configuración...')

  await db.transaction(async tx => {
    await tx.delete(schema.puntuacionJornada)
    await tx.delete(schema.estadisticaJornada)
    await tx.delete(schema.estadisticaJornadaSinRegistrar)
    await tx.delete(schema.snapshotAlineacion)
    await tx.delete(schema.penalizacionJornada)
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
    await tx.delete(schema.aliasEquipo)
    await tx.delete(schema.aliasJugador)
    await tx.delete(schema.jornada)
    await tx.delete(schema.jugadorEquipo)
    await tx.delete(schema.jugador)
    await tx.delete(schema.equipo)
    await tx.delete(schema.miembroLiga)
    await tx.delete(schema.liga)
    await tx.delete(schema.usuario)
  })

  console.log('✓ Borrado completo.')
  console.log('  Se mantienen: divisiones, configPuntuacion, configEconomia, configRevalorizacion.')

  await pool.end()
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
