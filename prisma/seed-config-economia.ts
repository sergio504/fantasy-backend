import { drizzle } from 'drizzle-orm/mysql2'
import mysql from 'mysql2/promise'
import crypto from 'crypto'
import * as schema from '../src/db/schema'
import dotenv from 'dotenv'

if (!process.env.DATABASE_URL) dotenv.config()

const ECONOMIA = [
  { clave: 'INGRESO_FIJO',      valor: 500_000,   descripcion: 'Ingreso fijo por jornada para todos los equipos' },
  { clave: 'INGRESO_POR_PUNTO', valor:  50_000,   descripcion: 'Ingreso adicional por cada punto conseguido' },
  { clave: 'BONUS_P1',          valor: 3_000_000, descripcion: 'Bonus por quedar 1º en la liga esta jornada' },
  { clave: 'BONUS_P2',          valor: 2_000_000, descripcion: 'Bonus por quedar 2º en la liga esta jornada' },
  { clave: 'BONUS_P3',          valor: 1_500_000, descripcion: 'Bonus por quedar 3º en la liga esta jornada' },
  { clave: 'BONUS_P4',          valor: 1_000_000, descripcion: 'Bonus por quedar 4º en la liga esta jornada' },
  { clave: 'BONUS_P5',          valor:   500_000, descripcion: 'Bonus por quedar 5º en la liga esta jornada' },
]

const REVALORIZACION = [
  { orden: 1, puntosHasta:    0, porcentaje:  -8, descripcion: '0 puntos' },
  { orden: 2, puntosHasta:    4, porcentaje:  -5, descripcion: '1-4 puntos' },
  { orden: 3, puntosHasta:    8, porcentaje:  -2, descripcion: '5-8 puntos' },
  { orden: 4, puntosHasta:   12, porcentaje:   3, descripcion: '9-12 puntos' },
  { orden: 5, puntosHasta:   17, porcentaje:   7, descripcion: '13-17 puntos' },
  { orden: 6, puntosHasta: null, porcentaje:  12, descripcion: '18+ puntos' },
]

async function main() {
  const pool = mysql.createPool({ uri: process.env.DATABASE_URL! })
  const db = drizzle(pool, { schema, mode: 'default' })

  for (const e of ECONOMIA) {
    await db.insert(schema.configEconomia)
      .values({ id: crypto.randomUUID(), ...e })
      .onDuplicateKeyUpdate({ set: { valor: e.valor } })
  }
  console.log(`✅ ${ECONOMIA.length} entradas de economía insertadas`)

  for (const r of REVALORIZACION) {
    await db.insert(schema.configRevalorizacion)
      .values({ id: crypto.randomUUID(), ...r })
      .onDuplicateKeyUpdate({ set: { porcentaje: r.porcentaje } })
  }
  console.log(`✅ ${REVALORIZACION.length} tramos de revalorización insertados`)

  await pool.end()
}

main().catch(e => { console.error(e); process.exit(1) })
