import { drizzle } from 'drizzle-orm/mysql2'
import { eq, and, inArray, notInArray } from 'drizzle-orm'
import mysql from 'mysql2/promise'
import bcrypt from 'bcryptjs'
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import * as schema from '../src/db/schema'
import type { Division, Posicion, AccionPuntuacion, ResultadoPartido } from '../src/db/schema'
import dotenv from 'dotenv'

dotenv.config()

// ─── HELPERS ───────────────────────────────────────

function uuid() { return crypto.randomUUID() }
function rand(min: number, max: number) { return Math.floor(Math.random() * (max - min + 1)) + min }
function prob(p: number) { return Math.random() < p }
function shuffle<T>(arr: T[]): T[] { return [...arr].sort(() => Math.random() - 0.5) }
function daysAgo(n: number) { const d = new Date(); d.setDate(d.getDate() - n); return d }

// ─── CONFIG DE PUNTUACIÓN ──────────────────────────

const CONFIG_PUNTUACION: { posicion: Posicion | null; accion: AccionPuntuacion; puntos: number; descripcion: string }[] = [
  { posicion: null,             accion: 'CONVOCADO',       puntos:  1, descripcion: 'Estar convocado' },
  { posicion: null,             accion: 'TITULAR',          puntos:  2, descripcion: 'Salir de titular' },
  { posicion: null,             accion: 'MINUTOS_60',       puntos:  1, descripcion: 'Jugar más de 60 minutos' },
  { posicion: null,             accion: 'TARJETA_AMARILLA', puntos: -1, descripcion: 'Tarjeta amarilla' },
  { posicion: null,             accion: 'TARJETA_ROJA',     puntos: -3, descripcion: 'Tarjeta roja' },
  { posicion: null,             accion: 'VICTORIA',         puntos:  3, descripcion: 'Victoria del equipo' },
  { posicion: null,             accion: 'EMPATE',           puntos:  1, descripcion: 'Empate del equipo' },
  { posicion: null,             accion: 'DERROTA',          puntos:  0, descripcion: 'Derrota del equipo' },
  { posicion: 'PORTERO',        accion: 'GOL',              puntos:  8, descripcion: 'Gol de portero' },
  { posicion: 'DEFENSA',        accion: 'GOL',              puntos:  6, descripcion: 'Gol de defensa' },
  { posicion: 'CENTROCAMPISTA', accion: 'GOL',              puntos:  5, descripcion: 'Gol de centrocampista' },
  { posicion: 'DELANTERO',      accion: 'GOL',              puntos:  4, descripcion: 'Gol de delantero' },
  { posicion: 'UNKNOWN',        accion: 'GOL',              puntos:  4, descripcion: 'Gol (posición desconocida)' },
]

// ─── IMPORTAR JUGADORES ────────────────────────────

interface JugadorJSON { nombreCompleto: string; nombre: string; dorsal: number | null; edad: number | null; posicion: string }
interface EntradaJSON  { equipo: { nombre: string; division: string }; jugadores: JugadorJSON[] }

const POSICION_VALS = ['PORTERO', 'DEFENSA', 'CENTROCAMPISTA', 'DELANTERO', 'UNKNOWN']
const JSON_FILES = [
  { file: 'jugadores_honor_bizkaia.json', division: 'HONOR_BIZKAIA' as Division },
  { file: 'jugadores_2rfef.json',         division: 'RFEF2_GRUPO_II' as Division },
  { file: 'jugadores_3rfef.json',         division: 'RFEF3_GRUPO_IV' as Division },
]

async function importarJugadores(db: ReturnType<typeof drizzle<typeof schema>>) {
  const now = new Date()
  for (const { file } of JSON_FILES) {
    const filePath = path.resolve(__dirname, '../../', file)
    if (!fs.existsSync(filePath)) { console.log(`  ⚠ No encontrado: ${file}`); continue }

    const datos: EntradaJSON[] = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    for (const entrada of datos) {
      const div = entrada.equipo.division as Division
      let [equipoExistente] = await db.select().from(schema.equipo)
        .where(and(eq(schema.equipo.nombre, entrada.equipo.nombre), eq(schema.equipo.division, div)))
        .limit(1)

      if (!equipoExistente) {
        const id = uuid()
        await db.insert(schema.equipo).values({ id, nombre: entrada.equipo.nombre, division: div, creadoEn: now })
        ;[equipoExistente] = await db.select().from(schema.equipo).where(eq(schema.equipo.id, id)).limit(1)
      }

      for (const j of entrada.jugadores) {
        const posicion = (POSICION_VALS.includes(j.posicion) ? j.posicion : 'UNKNOWN') as Posicion
        const valor = rand(5, 60)
        const jugadorId = uuid()
        await db.insert(schema.jugador).values({
          id: jugadorId, nombreCompleto: j.nombreCompleto, nombre: j.nombre,
          dorsal: j.dorsal ?? undefined, edad: j.edad ?? undefined, posicion, valor, creadoEn: now,
        })
        await db.insert(schema.jugadorEquipo).values({
          id: uuid(), jugadorId, equipoId: equipoExistente.id, desde: now, activo: true, creadoEn: now,
        })
      }
    }
    console.log(`  ✓ ${file} importado`)
  }
}

// ─── ASIGNAR PLANTILLA ─────────────────────────────

const CUPOS: Partial<Record<Posicion, number>> = { PORTERO: 2, DEFENSA: 5, CENTROCAMPISTA: 5, DELANTERO: 4 }

async function asignarPlantilla(
  db: ReturnType<typeof drizzle<typeof schema>>,
  miembroLigaId: string, ligaId: string, division: Division,
) {
  const now = new Date()

  const posiciones = Object.keys(CUPOS) as Posicion[]
  const seleccionados: { id: string; posicion: Posicion; valor: number }[] = []
  const idsOcupados: string[] = []

  // Precargar los ya ocupados en esta liga
  const ocupados = await db.select({ jugadorId: schema.plantillaFantasy.jugadorId })
    .from(schema.plantillaFantasy).where(eq(schema.plantillaFantasy.ligaId, ligaId))
  ocupados.forEach(p => idsOcupados.push(p.jugadorId))

  for (const pos of posiciones) {
    const baseWhere = and(
      eq(schema.jugador.posicion, pos),
      eq(schema.jugadorEquipo.activo, true),
      eq(schema.equipo.division, division),
    )
    const whereClause = idsOcupados.length > 0
      ? and(baseWhere!, notInArray(schema.jugador.id, idsOcupados))
      : baseWhere

    const candidatos = await db.select({
      id: schema.jugador.id, posicion: schema.jugador.posicion, valor: schema.jugador.valor,
    })
      .from(schema.jugador)
      .innerJoin(schema.jugadorEquipo, eq(schema.jugadorEquipo.jugadorId, schema.jugador.id))
      .innerJoin(schema.equipo, eq(schema.equipo.id, schema.jugadorEquipo.equipoId))
      .where(whereClause)
      .limit(80)

    const elegidos = shuffle(candidatos).slice(0, CUPOS[pos] ?? 0)
    seleccionados.push(...elegidos)
    elegidos.forEach(j => idsOcupados.push(j.id))
  }

  if (seleccionados.length < 16) throw new Error(`No hay suficientes jugadores libres en ${division} (encontrados: ${seleccionados.length})`)

  for (const j of seleccionados) {
    await db.insert(schema.plantillaFantasy).values({
      id: uuid(), ligaId, miembroLigaId, jugadorId: j.id, precioCompra: j.valor, creadoEn: now,
    })
  }

  return seleccionados
}

// ─── PONER 11 TITULARES (4-3-3) ────────────────────

async function setTitulares(
  db: ReturnType<typeof drizzle<typeof schema>>,
  miembroLigaId: string,
  jugadores: { id: string; posicion: Posicion }[],
) {
  const slots: Partial<Record<Posicion, number>> = { PORTERO: 1, DEFENSA: 4, CENTROCAMPISTA: 3, DELANTERO: 3 }
  const titulares: string[] = []
  const conteo: Partial<Record<Posicion, number>> = {}
  const capitanId = jugadores.find(j => j.posicion === 'DELANTERO')?.id ?? jugadores[0].id

  for (const j of shuffle(jugadores)) {
    const max = slots[j.posicion] ?? 0
    const actual = conteo[j.posicion] ?? 0
    if (actual < max) { titulares.push(j.id); conteo[j.posicion] = actual + 1 }
    if (titulares.length === 11) break
  }

  await db.delete(schema.titularLiga).where(eq(schema.titularLiga.miembroLigaId, miembroLigaId))
  for (const jugadorId of titulares) {
    await db.insert(schema.titularLiga).values({ id: uuid(), miembroLigaId, jugadorId })
  }
  await db.update(schema.miembroLiga)
    .set({ formacion: '4-3-3', capitanId })
    .where(eq(schema.miembroLiga.id, miembroLigaId))
}

// ─── CALCULAR PUNTOS CON CONFIG ────────────────────

function calcularPuntos(
  config: typeof schema.configPuntuacion.$inferSelect[],
  pos: Posicion,
  stats: {
    convocado: boolean; titular: boolean; minutosJugados: number;
    goles: number; tarjetasAmarillas: number; tarjetaRoja: boolean;
    resultado: ResultadoPartido;
  },
): { total: number; desglose: Record<string, unknown> } {
  function pts(accion: AccionPuntuacion): number {
    return config.find(c => c.accion === accion && c.posicion === pos)?.puntos
      ?? config.find(c => c.accion === accion && c.posicion === null)?.puntos ?? 0
  }
  const desglose: Record<string, unknown> = {}
  let total = 0

  if (stats.convocado)          { const p = pts('CONVOCADO');       desglose.convocado = p; total += p }
  if (stats.titular)            { const p = pts('TITULAR');         desglose.titular = p; total += p }
  if (stats.minutosJugados > 60){ const p = pts('MINUTOS_60');      desglose.minutos60 = p; total += p }
  if (stats.goles > 0)          { const u = pts('GOL'); const t = u * stats.goles; desglose.goles = { cantidad: stats.goles, puntosUnitarios: u, total: t }; total += t }
  if (stats.tarjetasAmarillas > 0){ const u = pts('TARJETA_AMARILLA'); const t = u * stats.tarjetasAmarillas; desglose.tarjetasAmarillas = { cantidad: stats.tarjetasAmarillas, puntosUnitarios: u, total: t }; total += t }
  if (stats.tarjetaRoja)        { const p = pts('TARJETA_ROJA');   desglose.tarjetaRoja = p; total += p }
  const accionRes = stats.resultado === 'VICTORIA' ? 'VICTORIA' : stats.resultado === 'EMPATE' ? 'EMPATE' : 'DERROTA'
  const pRes = pts(accionRes as AccionPuntuacion)
  desglose.resultado = { tipo: stats.resultado, puntos: pRes }; total += pRes

  return { total, desglose }
}

// ─── SIMULAR JORNADA ───────────────────────────────

async function simularJornada(
  db: ReturnType<typeof drizzle<typeof schema>>,
  jornadaId: string, division: Division,
  configPts: typeof schema.configPuntuacion.$inferSelect[],
) {
  const jugadoresEquipo = await db.select({
    jeId: schema.jugadorEquipo.id,
    equipoId: schema.jugadorEquipo.equipoId,
    jugadorId: schema.jugador.id,
    posicion: schema.jugador.posicion,
  })
    .from(schema.jugadorEquipo)
    .innerJoin(schema.jugador, eq(schema.jugador.id, schema.jugadorEquipo.jugadorId))
    .innerJoin(schema.equipo, eq(schema.equipo.id, schema.jugadorEquipo.equipoId))
    .where(and(eq(schema.jugadorEquipo.activo, true), eq(schema.equipo.division, division)))

  const resultadosPorEquipo = new Map<string, ResultadoPartido>()
  const resultados: ResultadoPartido[] = ['VICTORIA', 'EMPATE', 'DERROTA']

  for (const je of jugadoresEquipo) {
    if (!resultadosPorEquipo.has(je.equipoId)) {
      resultadosPorEquipo.set(je.equipoId, resultados[rand(0, 2)])
    }
    const resultado = resultadosPorEquipo.get(je.equipoId)!
    const convocado = prob(0.75)
    const titular   = convocado && prob(0.65)
    const minutosJugados = titular ? rand(45, 95) : convocado && prob(0.4) ? rand(1, 44) : 0
    const goles = minutosJugados > 0 ? (prob(0.10) ? rand(1, 2) : 0) : 0
    const tarjetasAmarillas = minutosJugados > 0 ? (prob(0.15) ? 1 : 0) : 0
    const tarjetaRoja = minutosJugados > 0 && !tarjetasAmarillas && prob(0.03)

    const pos = je.posicion as Posicion
    const { total, desglose } = calcularPuntos(configPts, pos, {
      convocado, titular, minutosJugados, goles, tarjetasAmarillas, tarjetaRoja, resultado,
    })

    await db.insert(schema.estadisticaJornada).values({
      id: uuid(), jornadaId, jugadorEquipoId: je.jeId,
      convocado, titular, minutosJugados, goles,
      tarjetasAmarillas, tarjetaRoja,
      resultado, golesEncajados: 0, golesAFavor: 0, golEnPropia: 0, diferenciaGoles: 0,
      puntosCalculados: total, desglose,
    })
  }

  return jugadoresEquipo.length
}

// ─── GENERAR SNAPSHOT ──────────────────────────────

async function generarSnapshot(
  db: ReturnType<typeof drizzle<typeof schema>>,
  jornadaId: string, ligaIds: string[],
) {
  const now = new Date()
  if (ligaIds.length === 0) return 0

  const miembros = await db.select({
    id: schema.miembroLiga.id,
    capitanId: schema.miembroLiga.capitanId,
  })
    .from(schema.miembroLiga)
    .where(inArray(schema.miembroLiga.ligaId, ligaIds))

  let total = 0
  for (const m of miembros) {
    const titulares = await db.select({ jugadorId: schema.titularLiga.jugadorId })
      .from(schema.titularLiga).where(eq(schema.titularLiga.miembroLigaId, m.id))

    for (const t of titulares) {
      const [je] = await db.select({ id: schema.jugadorEquipo.id })
        .from(schema.jugadorEquipo)
        .where(and(eq(schema.jugadorEquipo.jugadorId, t.jugadorId), eq(schema.jugadorEquipo.activo, true)))
        .limit(1)
      if (!je) continue

      await db.insert(schema.snapshotAlineacion).values({
        id: uuid(), jornadaId, miembroLigaId: m.id,
        jugadorEquipoId: je.id, esCapitan: m.capitanId === t.jugadorId, creadoEn: now,
      }).onDuplicateKeyUpdate({ set: { esCapitan: m.capitanId === t.jugadorId } })
      total++
    }
  }
  return total
}

// ─── CALCULAR PUNTUACIONES ─────────────────────────

async function calcularPuntuaciones(
  db: ReturnType<typeof drizzle<typeof schema>>,
  jornadaId: string, ligaIds: string[],
) {
  if (ligaIds.length === 0) return

  const miembros = await db.select({ id: schema.miembroLiga.id })
    .from(schema.miembroLiga).where(inArray(schema.miembroLiga.ligaId, ligaIds))

  const snapshots = await db.select({
    miembroLigaId: schema.snapshotAlineacion.miembroLigaId,
    jugadorEquipoId: schema.snapshotAlineacion.jugadorEquipoId,
    esCapitan: schema.snapshotAlineacion.esCapitan,
  }).from(schema.snapshotAlineacion).where(eq(schema.snapshotAlineacion.jornadaId, jornadaId))

  const estadisticas = await db.select({
    jugadorEquipoId: schema.estadisticaJornada.jugadorEquipoId,
    puntosCalculados: schema.estadisticaJornada.puntosCalculados,
  }).from(schema.estadisticaJornada).where(eq(schema.estadisticaJornada.jornadaId, jornadaId))

  const statsMap = new Map(estadisticas.map(e => [e.jugadorEquipoId, e.puntosCalculados]))

  const miembroIds = new Set(miembros.map(m => m.id))
  const porMiembro = new Map<string, typeof snapshots>()
  for (const s of snapshots) {
    if (!miembroIds.has(s.miembroLigaId)) continue
    if (!porMiembro.has(s.miembroLigaId)) porMiembro.set(s.miembroLigaId, [])
    porMiembro.get(s.miembroLigaId)!.push(s)
  }

  for (const [miembroLigaId, snaps] of porMiembro) {
    let total = 0
    for (const s of snaps) {
      const pts = statsMap.get(s.jugadorEquipoId) ?? 0
      total += s.esCapitan ? pts * 2 : pts
    }
    await db.insert(schema.puntuacionJornada).values({ id: uuid(), jornadaId, miembroLigaId, puntos: total })
      .onDuplicateKeyUpdate({ set: { puntos: total } })
    await db.update(schema.miembroLiga)
      .set({ puntuacion: total })
      .where(eq(schema.miembroLiga.id, miembroLigaId))
  }
}

// ─── MAIN ──────────────────────────────────────────

async function main() {
  const pool = mysql.createPool({ uri: process.env.DATABASE_URL! })
  const db = drizzle(pool, { schema, mode: 'default' })
  const now = new Date()

  // ── 1. Limpiar ──────────────────────────────────
  console.log('🧹 Limpiando base de datos...')
  await db.delete(schema.puntuacionJornada)
  await db.delete(schema.snapshotAlineacion)
  await db.delete(schema.estadisticaJornada)
  await db.delete(schema.jornada)
  await db.delete(schema.historialAdmin)
  await db.delete(schema.puja)
  await db.delete(schema.transferencia)
  await db.delete(schema.ofertaMercado)
  await db.delete(schema.titularLiga)
  await db.delete(schema.plantillaFantasy)
  await db.delete(schema.miembroLiga)
  await db.delete(schema.liga)
  await db.delete(schema.jugadorEquipo)
  await db.delete(schema.jugador)
  await db.delete(schema.equipo)
  await db.delete(schema.configPuntuacion)
  await db.delete(schema.usuario)
  console.log('  ✓ Limpieza completada')

  // ── 2. Config puntuación ─────────────────────────
  console.log('\n⚙️  Insertando configuración de puntuación...')
  const desde = new Date('2025-08-01')
  for (const c of CONFIG_PUNTUACION) {
    await db.insert(schema.configPuntuacion).values({
      id: uuid(), posicion: c.posicion, accion: c.accion,
      puntos: c.puntos, desde, activo: true, descripcion: c.descripcion,
    })
  }
  const configPts = await db.select().from(schema.configPuntuacion).where(eq(schema.configPuntuacion.activo, true))
  console.log(`  ✓ ${CONFIG_PUNTUACION.length} reglas de puntuación`)

  // ── 3. Jugadores reales ──────────────────────────
  console.log('\n⚽ Importando jugadores...')
  await importarJugadores(db as any)

  // ── 4. Usuarios ───────────────────────────────────
  console.log('\n👤 Creando usuarios...')
  const pass = await bcrypt.hash('demo123', 10)
  const usersData = [
    { id: uuid(), email: 'sergio@demo.com', username: 'Sergio',  esAdmin: true  },
    { id: uuid(), email: 'mikel@demo.com',  username: 'Mikel',   esAdmin: false },
    { id: uuid(), email: 'iker@demo.com',   username: 'Iker',    esAdmin: false },
    { id: uuid(), email: 'june@demo.com',   username: 'June',    esAdmin: false },
    { id: uuid(), email: 'unai@demo.com',   username: 'Unai',    esAdmin: false },
    { id: uuid(), email: 'aitor@demo.com',  username: 'Aitor',   esAdmin: false },
  ]
  for (const u of usersData) {
    await db.insert(schema.usuario).values({
      ...u, contrasena: pass, creadoEn: now, activo: true,
    })
  }
  const [sergio, mikel, iker, june, unai, aitor] = usersData
  console.log('  ✓ 6 usuarios (contraseña: demo123)')

  // ── 5. Ligas ──────────────────────────────────────
  console.log('\n🏆 Creando ligas...')

  // Liga 1: Honor Bizkaia — pública — 5 miembros
  const ligaHonorId = uuid()
  await db.insert(schema.liga).values({
    id: ligaHonorId, nombre: 'Honor Bizkaia Fantasy 25/26', creadorId: sergio.id,
    division: 'HONOR_BIZKAIA', publica: true, maxEquipos: 8, presupuestoInicial: 100, creadoEn: now,
  })
  const membrosHonor: { id: string; usuarioId: string }[] = []
  for (const u of [sergio, mikel, iker, june, unai]) {
    const id = uuid()
    await db.insert(schema.miembroLiga).values({
      id, ligaId: ligaHonorId, usuarioId: u.id, presupuestoRestante: rand(60, 100), creadoEn: now,
    })
    membrosHonor.push({ id, usuarioId: u.id })
  }

  // Liga 2: 2ª RFEF — privada — 4 miembros
  const liga2RfefId = uuid()
  await db.insert(schema.liga).values({
    id: liga2RfefId, nombre: 'La Peña 2ª RFEF', creadorId: unai.id,
    division: 'RFEF2_GRUPO_II', publica: false, codigoInvitacion: 'PEÑA2024',
    maxEquipos: 6, presupuestoInicial: 80, creadoEn: now,
  })
  const membros2Rfef: { id: string; usuarioId: string }[] = []
  for (const u of [unai, mikel, iker, aitor]) {
    const id = uuid()
    await db.insert(schema.miembroLiga).values({
      id, ligaId: liga2RfefId, usuarioId: u.id, presupuestoRestante: rand(50, 80), creadoEn: now,
    })
    membros2Rfef.push({ id, usuarioId: u.id })
  }

  // Liga 3: 3ª RFEF — pública — 3 miembros
  const liga3RfefId = uuid()
  await db.insert(schema.liga).values({
    id: liga3RfefId, nombre: 'Tercera División Fantasy', creadorId: aitor.id,
    division: 'RFEF3_GRUPO_IV', publica: true, maxEquipos: 10, presupuestoInicial: 60, creadoEn: now,
  })
  const membros3Rfef: { id: string; usuarioId: string }[] = []
  for (const u of [aitor, sergio, june]) {
    const id = uuid()
    await db.insert(schema.miembroLiga).values({
      id, ligaId: liga3RfefId, usuarioId: u.id, presupuestoRestante: rand(30, 60), creadoEn: now,
    })
    membros3Rfef.push({ id, usuarioId: u.id })
  }

  console.log('  ✓ 3 ligas creadas')

  // ── 6. Plantillas y alineaciones ──────────────────
  console.log('\n🗂  Asignando plantillas...')
  const plantillasHonor: Map<string, { id: string; posicion: Posicion }[]> = new Map()
  for (const m of membrosHonor) {
    const jugadores = await asignarPlantilla(db as any, m.id, ligaHonorId, 'HONOR_BIZKAIA')
    await setTitulares(db as any, m.id, jugadores)
    plantillasHonor.set(m.id, jugadores)
    console.log(`  ✓ Honor - ${m.usuarioId.slice(0,8)}: ${jugadores.length} jugadores`)
  }
  const plantillas2Rfef: Map<string, { id: string; posicion: Posicion }[]> = new Map()
  for (const m of membros2Rfef) {
    const jugadores = await asignarPlantilla(db as any, m.id, liga2RfefId, 'RFEF2_GRUPO_II')
    await setTitulares(db as any, m.id, jugadores)
    plantillas2Rfef.set(m.id, jugadores)
  }
  const plantillas3Rfef: Map<string, { id: string; posicion: Posicion }[]> = new Map()
  for (const m of membros3Rfef) {
    const jugadores = await asignarPlantilla(db as any, m.id, liga3RfefId, 'RFEF3_GRUPO_IV')
    await setTitulares(db as any, m.id, jugadores)
    plantillas3Rfef.set(m.id, jugadores)
  }
  console.log('  ✓ Todas las plantillas asignadas')

  // ── 7. Jornadas y estadísticas ────────────────────
  console.log('\n📅 Simulando jornadas...')

  const DIVISIONES_LIGAS: { division: Division; ligaIds: string[]; nombre: string }[] = [
    { division: 'HONOR_BIZKAIA',  ligaIds: [ligaHonorId],   nombre: 'Honor Bizkaia' },
    { division: 'RFEF2_GRUPO_II', ligaIds: [liga2RfefId],   nombre: '2ª RFEF' },
    { division: 'RFEF3_GRUPO_IV', ligaIds: [liga3RfefId],   nombre: '3ª RFEF' },
  ]

  const NUM_JORNADAS = 6

  for (const { division, ligaIds, nombre } of DIVISIONES_LIGAS) {
    for (let n = 1; n <= NUM_JORNADAS; n++) {
      const fechaInicioJornada = daysAgo((NUM_JORNADAS - n + 1) * 7)
      const jornadaId = uuid()
      await db.insert(schema.jornada).values({ id: jornadaId, division, numJornada: n, fechaInicioJornada })

      const snaps = await generarSnapshot(db as any, jornadaId, ligaIds)
      const stats = await simularJornada(db as any, jornadaId, division, configPts)
      await calcularPuntuaciones(db as any, jornadaId, ligaIds)
      console.log(`  ✓ ${nombre} — J${n}: ${stats} estadísticas, ${snaps} snapshots`)
    }
  }

  // ── 8. Recalcular puntuacion acumulada ────────────
  console.log('\n🔢 Recalculando puntuaciones acumuladas...')
  const todasLasLigas = [
    { ligaId: ligaHonorId,  miembros: membrosHonor },
    { ligaId: liga2RfefId,  miembros: membros2Rfef },
    { ligaId: liga3RfefId,  miembros: membros3Rfef },
  ]
  for (const { miembros } of todasLasLigas) {
    for (const m of miembros) {
      const puntuaciones = await db.select({ puntos: schema.puntuacionJornada.puntos })
        .from(schema.puntuacionJornada).where(eq(schema.puntuacionJornada.miembroLigaId, m.id))
      const total = puntuaciones.reduce((sum, p) => sum + p.puntos, 0)
      await db.update(schema.miembroLiga).set({ puntuacion: total }).where(eq(schema.miembroLiga.id, m.id))
    }
  }
  console.log('  ✓ Puntuaciones acumuladas actualizadas')

  // ── 9. Mercado: ofertas activas con pujas ─────────
  console.log('\n💰 Creando mercado...')

  // Jugadores del sistema (sin vendedor) en liga Honor
  const jugadoresLibresHonor = await db.select({ id: schema.jugador.id, valor: schema.jugador.valor })
    .from(schema.jugador)
    .innerJoin(schema.jugadorEquipo, eq(schema.jugadorEquipo.jugadorId, schema.jugador.id))
    .innerJoin(schema.equipo, eq(schema.equipo.id, schema.jugadorEquipo.equipoId))
    .where(and(
      eq(schema.jugadorEquipo.activo, true),
      eq(schema.equipo.division, 'HONOR_BIZKAIA'),
      notInArray(schema.jugador.id,
        (await db.select({ jugadorId: schema.plantillaFantasy.jugadorId })
          .from(schema.plantillaFantasy)
          .where(eq(schema.plantillaFantasy.ligaId, ligaHonorId))
        ).map(p => p.jugadorId)
      ),
    ))
    .limit(5)

  const ofertaIds: string[] = []
  for (const j of jugadoresLibresHonor.slice(0, 3)) {
    const ofertaId = uuid()
    const caducidad = new Date(); caducidad.setDate(caducidad.getDate() + rand(3, 14))
    await db.insert(schema.ofertaMercado).values({
      id: ofertaId, ligaId: ligaHonorId, jugadorId: j.id,
      vendedorId: null, precioMinimo: j.valor, estado: 'ACTIVA',
      fechaCaducidad: caducidad, creadoEn: now,
    })
    ofertaIds.push(ofertaId)
  }

  // Algunos miembros ponen jugadores de su plantilla a la venta
  for (const m of membrosHonor.slice(0, 2)) {
    const plantilla = await db.select({ jugadorId: schema.plantillaFantasy.jugadorId })
      .from(schema.plantillaFantasy)
      .where(eq(schema.plantillaFantasy.miembroLigaId, m.id))
      .limit(4)

    const titularesActuales = await db.select({ jugadorId: schema.titularLiga.jugadorId })
      .from(schema.titularLiga).where(eq(schema.titularLiga.miembroLigaId, m.id))
    const titularIds = new Set(titularesActuales.map(t => t.jugadorId))

    const suplente = plantilla.find(p => !titularIds.has(p.jugadorId))
    if (!suplente) continue

    const [jugInfo] = await db.select({ valor: schema.jugador.valor })
      .from(schema.jugador).where(eq(schema.jugador.id, suplente.jugadorId)).limit(1)
    const ofertaId = uuid()
    await db.insert(schema.ofertaMercado).values({
      id: ofertaId, ligaId: ligaHonorId, jugadorId: suplente.jugadorId,
      vendedorId: m.id, precioMinimo: jugInfo?.valor ?? 10, estado: 'ACTIVA',
      fechaCaducidad: new Date(Date.now() + 7 * 86400000), creadoEn: now,
    })
    ofertaIds.push(ofertaId)
  }

  // Pujas sobre las ofertas (miembros distintos al vendedor)
  for (const ofertaId of ofertaIds.slice(0, 3)) {
    const [oferta] = await db.select({ vendedorId: schema.ofertaMercado.vendedorId, precioMinimo: schema.ofertaMercado.precioMinimo })
      .from(schema.ofertaMercado).where(eq(schema.ofertaMercado.id, ofertaId)).limit(1)
    if (!oferta) continue

    const pujadores = membrosHonor.filter(m => m.id !== oferta.vendedorId).slice(0, rand(1, 3))
    let precioActual = oferta.precioMinimo
    for (const pujador of pujadores) {
      precioActual += rand(2, 8)
      await db.insert(schema.puja).values({
        id: uuid(), ofertaMercadoId: ofertaId, miembroLigaId: pujador.id, cantidad: precioActual, creadoEn: now,
      }).onDuplicateKeyUpdate({ set: { cantidad: precioActual } })
    }
  }
  console.log(`  ✓ ${ofertaIds.length} ofertas activas con pujas`)

  // ── 10. Transferencias históricas ─────────────────
  console.log('\n📋 Creando historial de transferencias...')
  const transferenciasData = []
  for (let i = 0; i < 5; i++) {
    const comprador = membrosHonor[rand(1, membrosHonor.length - 1)]
    const vendedor  = i % 2 === 0 ? null : membrosHonor[0].id
    const [jugParaTransf] = await db.select({ id: schema.jugador.id })
      .from(schema.jugador)
      .innerJoin(schema.jugadorEquipo, eq(schema.jugadorEquipo.jugadorId, schema.jugador.id))
      .innerJoin(schema.equipo, eq(schema.equipo.id, schema.jugadorEquipo.equipoId))
      .where(and(eq(schema.jugadorEquipo.activo, true), eq(schema.equipo.division, 'HONOR_BIZKAIA')))
      .orderBy(schema.jugador.id) // determinístico
      .limit(1)
      .offset(i * 3)
    if (!jugParaTransf) continue

    transferenciasData.push({
      id: uuid(), jugadorId: jugParaTransf.id, ligaId: ligaHonorId,
      vendedorId: vendedor, compradorId: comprador.id,
      precio: rand(8, 40), fecha: daysAgo(rand(1, 40)),
    })
  }
  for (const t of transferenciasData) {
    await db.insert(schema.transferencia).values(t)
  }
  console.log(`  ✓ ${transferenciasData.length} transferencias históricas`)

  // ── RESUMEN ───────────────────────────────────────
  console.log('\n✅ Seed de demo completado')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('Usuarios (contraseña: demo123):')
  for (const u of usersData) console.log(`  ${u.email}${u.esAdmin ? ' (admin)' : ''}`)
  console.log('Ligas:')
  console.log('  "Honor Bizkaia Fantasy 25/26" — pública — 5 miembros')
  console.log('  "La Peña 2ª RFEF" — privada — código: PEÑA2024 — 4 miembros')
  console.log('  "Tercera División Fantasy" — pública — 3 miembros')
  console.log(`Jornadas: ${NUM_JORNADAS} simuladas por división`)
  console.log(`Mercado: ${ofertaIds.length} ofertas activas con pujas`)
  console.log(`Transferencias: ${transferenciasData.length} registros históricos`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  await pool.end()
}

main().catch(e => { console.error(e); process.exit(1) })
