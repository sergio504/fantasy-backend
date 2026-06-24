import { drizzle } from 'drizzle-orm/mysql2'
import mysql from 'mysql2/promise'
import crypto from 'crypto'
import * as schema from '../src/db/schema'
import dotenv from 'dotenv'

if (!process.env.DATABASE_URL) dotenv.config()

const DIVISIONES = [
  {
    division:        'RFEF3_GRUPO_IV' as const,
    nombre:          'Tercera Federación - Grupo IV',
    temporada:       '25/26',
    urlCalendario:   'https://www.lapreferente.com/C22283-19/tercera-federacion-grupo-4/calendario.html',
    carpetaArchivos: 'tercera-federacion-grupo-4',
  },
]

async function main() {
  const pool = mysql.createPool({ uri: process.env.DATABASE_URL! })
  const db = drizzle(pool, { schema, mode: 'default' })

  for (const d of DIVISIONES) {
    await db.insert(schema.divisiones).values({
      id:              crypto.randomUUID(),
      division:        d.division,
      nombre:          d.nombre,
      temporada:       d.temporada,
      urlCalendario:   d.urlCalendario,
      carpetaArchivos: d.carpetaArchivos,
      activa:          true,
      creadoEn:        new Date(),
    }).onDuplicateKeyUpdate({ set: { nombre: d.nombre, urlCalendario: d.urlCalendario } })
  }

  console.log(`✅ ${DIVISIONES.length} divisiones insertadas`)
  await pool.end()
}

main().catch(e => { console.error(e); process.exit(1) })
