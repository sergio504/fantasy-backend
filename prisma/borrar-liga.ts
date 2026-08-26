import { drizzle } from 'drizzle-orm/mysql2'
import { inArray } from 'drizzle-orm'
import mysql from 'mysql2/promise'
import * as schema from '../src/db/schema'
import dotenv from 'dotenv'

dotenv.config()

// Borra la(s) liga(s) existentes y todo lo que cuelga de ellas (miembros,
// plantillas fantasy, mercado, históricos de saldo/cláusula, snapshots y
// puntuaciones de jornada). NO toca jornada/estadisticaJornada, que son
// datos de la temporada real compartidos entre ligas.
async function main() {
  const pool = mysql.createPool({ uri: process.env.DATABASE_URL! })
  const db = drizzle(pool, { schema, mode: 'default' })

  const ligas = await db.select({ id: schema.liga.id, nombre: schema.liga.nombre }).from(schema.liga)
  if (ligas.length === 0) { console.log('No hay ninguna liga que borrar.'); await pool.end(); return }

  const ligaIds = ligas.map(l => l.id)
  console.log(`🧹 Borrando ${ligas.length} liga(s): ${ligas.map(l => l.nombre).join(', ')}`)

  const miembros = await db.select({ id: schema.miembroLiga.id }).from(schema.miembroLiga).where(inArray(schema.miembroLiga.ligaId, ligaIds))
  const miembroIds = miembros.map(m => m.id)

  await db.transaction(async tx => {
    if (miembroIds.length > 0) {
      await tx.delete(schema.puntuacionJornada).where(inArray(schema.puntuacionJornada.miembroLigaId, miembroIds))
      await tx.delete(schema.snapshotAlineacion).where(inArray(schema.snapshotAlineacion.miembroLigaId, miembroIds))
      await tx.delete(schema.penalizacionJornada).where(inArray(schema.penalizacionJornada.miembroLigaId, miembroIds))
      await tx.delete(schema.titularLiga).where(inArray(schema.titularLiga.miembroLigaId, miembroIds))
      await tx.delete(schema.puja).where(inArray(schema.puja.miembroLigaId, miembroIds))
    }
    await tx.delete(schema.transferencia).where(inArray(schema.transferencia.ligaId, ligaIds))
    await tx.delete(schema.ofertaMercado).where(inArray(schema.ofertaMercado.ligaId, ligaIds))
    await tx.delete(schema.clausulazoPendiente).where(inArray(schema.clausulazoPendiente.ligaId, ligaIds))
    await tx.delete(schema.plantillaFantasy).where(inArray(schema.plantillaFantasy.ligaId, ligaIds))
    await tx.delete(schema.historialSaldo).where(inArray(schema.historialSaldo.ligaId, ligaIds))
    await tx.delete(schema.historialClausula).where(inArray(schema.historialClausula.ligaId, ligaIds))
    await tx.delete(schema.miembroLiga).where(inArray(schema.miembroLiga.ligaId, ligaIds))
    await tx.delete(schema.liga).where(inArray(schema.liga.id, ligaIds))
  })

  console.log('✓ Liga(s) borrada(s). Jugadores, equipos, config y jornadas sin tocar.')

  await pool.end()
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
