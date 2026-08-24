import { drizzle } from 'drizzle-orm/mysql2'
import { eq, and, inArray } from 'drizzle-orm'
import mysql from 'mysql2/promise'
import { randomUUID } from 'crypto'
import * as schema from '../src/db/schema'
import type { Posicion, ResultadoPartido } from '../src/db/schema'
import { calcularPuntos, generarSnapshotOp, calcularPuntosPorJugadorOp, calcularPuntuacionesOp } from '../src/lib/jornadaOps'
import dotenv from 'dotenv'

dotenv.config()

// Simula una jornada de principio a fin (snapshot → estadísticas falsas →
// calcular puntos → calcular puntuaciones) para probar en caliente que la
// cadena completa funciona con los últimos arreglos, sin depender de datos
// reales de scraping. Reutiliza la misma lógica que el botón "Simular" del
// panel de admin para generar las estadísticas.
function rand(min: number, max: number) { return Math.floor(Math.random() * (max - min + 1)) + min }
function prob(p: number) { return Math.random() < p }

async function main() {
  const division = process.argv[2] as schema.Division
  const numJornada = Number(process.argv[3])
  if (!division || !numJornada) {
    console.error('Uso: ts-node simular-jornada-test.ts <division> <numJornada>')
    process.exit(1)
  }

  const pool = mysql.createPool({ uri: process.env.DATABASE_URL! })
  const db = drizzle(pool, { schema, mode: 'default' })

  const [j] = await db.select().from(schema.jornada)
    .where(and(eq(schema.jornada.division, division), eq(schema.jornada.numJornada, numJornada))).limit(1)
  if (!j) { console.error('Jornada no encontrada'); process.exit(1) }

  const existentes = await db.select({ id: schema.estadisticaJornada.id }).from(schema.estadisticaJornada)
    .where(eq(schema.estadisticaJornada.jornadaId, j.id)).limit(1)
  if (existentes.length > 0) { console.error('Esta jornada ya tiene estadísticas. Bórralas primero si quieres re-simular.'); process.exit(1) }

  console.log('1) Generando snapshot...')
  console.log('  ' + await generarSnapshotOp(j.id))

  console.log('2) Generando estadísticas simuladas...')
  const config = await db.select().from(schema.configPuntuacion).where(eq(schema.configPuntuacion.activo, true))

  const jeRaw = await db.select({
    jeId: schema.jugadorEquipo.id, jeJugadorId: schema.jugadorEquipo.jugadorId, jeEquipoId: schema.jugadorEquipo.equipoId,
    jPosicion: schema.jugador.posicion, eDivision: schema.equipo.division,
  }).from(schema.jugadorEquipo)
    .innerJoin(schema.jugador, eq(schema.jugador.id, schema.jugadorEquipo.jugadorId))
    .innerJoin(schema.equipo, eq(schema.equipo.id, schema.jugadorEquipo.equipoId))
    .where(eq(schema.jugadorEquipo.activo, true))

  const jugadoresDivision = jeRaw.filter(r => r.eDivision === division)
  const resultadosPorEquipo = new Map<string, ResultadoPartido>()
  const resultados: ResultadoPartido[] = ['VICTORIA', 'EMPATE', 'DERROTA']
  const estadisticas = []

  for (const je of jugadoresDivision) {
    if (!resultadosPorEquipo.has(je.jeEquipoId)) resultadosPorEquipo.set(je.jeEquipoId, resultados[rand(0, 2)])
    const resultado         = resultadosPorEquipo.get(je.jeEquipoId)!
    const convocado         = prob(0.75)
    const titular           = convocado && prob(0.65)
    const minutosJugados    = titular ? rand(45, 95) : convocado && prob(0.4) ? rand(1, 44) : 0
    const goles             = minutosJugados > 0 ? (prob(0.12) ? rand(1, 2) : 0) : 0
    const tarjetasAmarillas = minutosJugados > 0 ? (prob(0.15) ? 1 : 0) : 0
    const tarjetaRoja       = minutosJugados > 0 && !tarjetasAmarillas && prob(0.03)
    const { total, desglose } = calcularPuntos(
      { convocado, titular, minutosJugados, goles, golesDePenalti: 0, golEnPropia: 0, golesAFavor: 0, golesEncajados: 0, diferenciaGoles: 0, tarjetasAmarillas, tarjetaRoja, resultado },
      je.jPosicion as Posicion, config,
    )
    estadisticas.push({ id: randomUUID(), jornadaId: j.id, jugadorEquipoId: je.jeId, convocado, titular, minutosJugados, goles, golesDePenalti: 0, tarjetasAmarillas, tarjetaRoja, resultado, puntosCalculados: total, desglose: desglose as any })
  }

  if (estadisticas.length > 0) await db.insert(schema.estadisticaJornada).values(estadisticas)
  await db.update(schema.jornada).set({ statsImportadas: true }).where(eq(schema.jornada.id, j.id))
  console.log(`  ${estadisticas.length} estadísticas simuladas`)

  console.log('3) Calculando puntos por jugador (revaloriza y registra historialValorJugador)...')
  console.log('  ' + await calcularPuntosPorJugadorOp(j.id))

  console.log('4) Calculando puntuaciones (reparte presupuesto y registra historialSaldo)...')
  console.log('  ' + await calcularPuntuacionesOp(j.id))

  console.log('\n✓ Simulación completa.')
  await pool.end()
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
