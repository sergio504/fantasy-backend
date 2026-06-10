import { drizzle } from 'drizzle-orm/mysql2'
import { eq, and } from 'drizzle-orm'
import mysql from 'mysql2/promise'
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import * as schema from '../src/db/schema'
import { Division, Posicion } from '../src/db/schema'
import dotenv from 'dotenv'

dotenv.config()

interface JugadorJSON {
  nombreCompleto: string
  nombre: string
  dorsal: number | null
  edad: number | null
  posicion: string
}

interface EntradaJSON {
  equipo: { nombre: string; division: string }
  jugadores: JugadorJSON[]
}

const JSON_FILES = [
  'jugadores_honor_bizkaia.json',
  'jugadores_2rfef.json',
  'jugadores_3rfef.json',
]

function uuid() {
  return crypto.randomUUID()
}

async function main() {
  const pool = mysql.createPool({ uri: process.env.DATABASE_URL! })
  const db = drizzle(pool, { schema: schema, mode: 'default' })

  const now = new Date()
  let totalEquipos = 0
  let totalJugadores = 0

  for (const fileName of JSON_FILES) {
    const jsonPath = path.resolve(__dirname, '../../', fileName)
    if (!fs.existsSync(jsonPath)) {
      console.warn(`⚠ No encontrado: ${fileName}`)
      continue
    }

    const datos: EntradaJSON[] = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'))
    console.log(`\n📂 ${fileName} — ${datos.length} equipos`)

    for (const entrada of datos) {
      const { equipo: equipoData, jugadores } = entrada

      // Buscar o crear equipo
      let [equipoExistente] = await db
        .select()
        .from(schema.equipo)
        .where(and(
          eq(schema.equipo.nombre, equipoData.nombre),
          eq(schema.equipo.division, equipoData.division as Division),
        ))
        .limit(1)

      if (!equipoExistente) {
        const id = uuid()
        await db.insert(schema.equipo).values({
          id,
          nombre: equipoData.nombre,
          division: equipoData.division as Division,
          creadoEn: now,
        })
        ;[equipoExistente] = await db
          .select()
          .from(schema.equipo)
          .where(eq(schema.equipo.id, id))
          .limit(1)
        totalEquipos++
      }

      let jugadoresNuevos = 0

      for (const j of jugadores) {
        const posicion = (posicionValues.includes(j.posicion as Posicion) ? j.posicion : 'UNKNOWN') as Posicion
        const valor = Math.floor(Math.random() * 56) + 5 // 5–60

        const jugadorId = uuid()
        await db.insert(schema.jugador).values({
          id: jugadorId,
          nombreCompleto: j.nombreCompleto,
          nombre: j.nombre,
          dorsal: j.dorsal ?? undefined,
          edad: j.edad ?? undefined,
          posicion,
          valor,
          creadoEn: now,
        })

        await db.insert(schema.jugadorEquipo).values({
          id: uuid(),
          jugadorId,
          equipoId: equipoExistente.id,
          desde: now,
          activo: true,
          creadoEn: now,
        })

        jugadoresNuevos++
      }

      console.log(`  ✓ ${equipoExistente.nombre} — ${jugadoresNuevos} jugadores`)
      totalJugadores += jugadoresNuevos
    }
  }

  console.log(`\n✅ Importación completada: ${totalEquipos} equipos, ${totalJugadores} jugadores`)
  await pool.end()
}

const posicionValues = ['PORTERO', 'DEFENSA', 'CENTROCAMPISTA', 'DELANTERO', 'UNKNOWN']

main().catch(e => { console.error(e); process.exit(1) })
