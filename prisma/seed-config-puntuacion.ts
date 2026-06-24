import { drizzle } from 'drizzle-orm/mysql2'
import mysql from 'mysql2/promise'
import * as schema from '../src/db/schema'
import { Posicion, AccionPuntuacion } from '../src/db/schema'
import dotenv from 'dotenv'

if (!process.env.DATABASE_URL) dotenv.config()

const DESDE = new Date('2025-08-01')

const CONFIG: { posicion: Posicion | null; accion: AccionPuntuacion; puntos: number; descripcion: string }[] = [
  { posicion: null, accion: 'CONVOCADO',       puntos:  1, descripcion: 'Estar convocado' },
  { posicion: null, accion: 'JUEGA',           puntos:  1, descripcion: 'Jugar algún minuto' },
  { posicion: null, accion: 'TITULAR',         puntos:  2, descripcion: 'Salir de titular' },
  { posicion: null, accion: 'MINUTOS_60',      puntos:  1, descripcion: 'Jugar más de 60 minutos' },
  { posicion: null, accion: 'TARJETA_AMARILLA',puntos: -1, descripcion: 'Tarjeta amarilla' },
  { posicion: null, accion: 'DOBLE_AMARILLA',  puntos: -2, descripcion: 'Doble amarilla' },
  { posicion: null, accion: 'TARJETA_ROJA',    puntos: -3, descripcion: 'Tarjeta roja directa' },
  { posicion: null, accion: 'VICTORIA',        puntos:  3, descripcion: 'Victoria del equipo' },
  { posicion: null, accion: 'EMPATE',          puntos:  1, descripcion: 'Empate del equipo' },
  { posicion: null, accion: 'DERROTA',         puntos:  0, descripcion: 'Derrota del equipo' },
  { posicion: null, accion: 'GOLEADA_FAVOR',   puntos:  2, descripcion: 'Goleada a favor (+3)' },
  { posicion: null, accion: 'GOLEADA_CONTRA',  puntos: -2, descripcion: 'Goleada en contra (+3)' },
  { posicion: null, accion: 'GOL_PROPIA',      puntos: -2, descripcion: 'Gol en propia meta' },

  { posicion: 'PORTERO',        accion: 'GOL',         puntos: 8, descripcion: 'Gol de portero' },
  { posicion: 'DEFENSA',        accion: 'GOL',         puntos: 6, descripcion: 'Gol de defensa' },
  { posicion: 'CENTROCAMPISTA', accion: 'GOL',         puntos: 5, descripcion: 'Gol de centrocampista' },
  { posicion: 'DELANTERO',      accion: 'GOL',         puntos: 4, descripcion: 'Gol de delantero' },
  { posicion: 'UNKNOWN',        accion: 'GOL',         puntos: 4, descripcion: 'Gol (posición desconocida)' },

  { posicion: 'PORTERO',        accion: 'GOL_PENALTY', puntos: 6, descripcion: 'Penalti de portero' },
  { posicion: 'DEFENSA',        accion: 'GOL_PENALTY', puntos: 4, descripcion: 'Penalti de defensa' },
  { posicion: 'CENTROCAMPISTA', accion: 'GOL_PENALTY', puntos: 3, descripcion: 'Penalti de centrocampista' },
  { posicion: 'DELANTERO',      accion: 'GOL_PENALTY', puntos: 3, descripcion: 'Penalti de delantero' },
  { posicion: 'UNKNOWN',        accion: 'GOL_PENALTY', puntos: 3, descripcion: 'Penalti (posición desconocida)' },

  { posicion: 'PORTERO',        accion: 'GOL_ENCAJADO', puntos: -1, descripcion: 'Gol encajado (portero)' },
  { posicion: 'DEFENSA',        accion: 'GOL_ENCAJADO', puntos:  0, descripcion: 'Gol encajado (defensa)' },
  { posicion: 'CENTROCAMPISTA', accion: 'GOL_ENCAJADO', puntos:  0, descripcion: 'Gol encajado (centrocampista)' },
  { posicion: 'DELANTERO',      accion: 'GOL_ENCAJADO', puntos:  0, descripcion: 'Gol encajado (delantero)' },
  { posicion: 'UNKNOWN',        accion: 'GOL_ENCAJADO', puntos:  0, descripcion: 'Gol encajado (unknown)' },
]

async function main() {
  const pool = mysql.createPool({ uri: process.env.DATABASE_URL! })
  const db = drizzle(pool, { schema, mode: 'default' })

  await db.update(schema.configPuntuacion)
    .set({ activo: false, hasta: DESDE })
    .where(schema.configPuntuacion.activo)

  for (const c of CONFIG) {
    await db.insert(schema.configPuntuacion).values({
      id:          crypto.randomUUID(),
      posicion:    c.posicion as Posicion | null,
      accion:      c.accion,
      puntos:      c.puntos,
      desde:       DESDE,
      activo:      true,
      descripcion: c.descripcion,
    })
  }

  console.log(`✅ ${CONFIG.length} reglas de puntuación insertadas`)
  await pool.end()
}

import crypto from 'crypto'
main().catch(e => { console.error(e); process.exit(1) })
