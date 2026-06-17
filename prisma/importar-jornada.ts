import { drizzle } from 'drizzle-orm/mysql2'
import { eq, and } from 'drizzle-orm'
import mysql from 'mysql2/promise'
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import * as schema from '../src/db/schema'
import { Division, ResultadoPartido } from '../src/db/schema'
import dotenv from 'dotenv'

dotenv.config()

// ── Configuración ─────────────────────────────────────────────
const DIVISION: Division = 'RFEF3_GRUPO_IV'
const numArg = process.argv[2]
if (!numArg || isNaN(Number(numArg))) {
  console.error('Uso: npx tsx prisma/importar-jornada.ts <numero_jornada>')
  process.exit(1)
}
const JSON_PATH = path.resolve(__dirname, `../jornada_${numArg}.json`)
// ──────────────────────────────────────────────────────────────

function uuid() { return crypto.randomUUID() }

function normalizar(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// Solo consonantes en mayúsculas (Ñ → N por NFD, vocales eliminadas)
function consonantes(s: string): string {
  return s
    .toUpperCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[AEIOU\s]/g, '')
    .replace(/[^A-Z]/g, '')
}

// ── Aliases (se cargan de BD al inicio de main) ───────────────
// Mapa invertido: alias normalizado -> nombre canónico normalizado del equipo/jugador en BD

let mapaAliasEquipos   = new Map<string, string>()
let mapaAliasJugadores = new Map<string, string>()

function resolverEquipo(nombre: string): string {
  const norm = normalizar(nombre)
  return mapaAliasEquipos.get(norm) ?? norm
}

function resolverJugador(nombre: string): string {
  const norm = normalizar(nombre)
  return mapaAliasJugadores.get(norm) ?? norm
}

// ── Interfaces del JSON ───────────────────────────────────────

interface GolJSON {
  jugador: string
  jugador_completo: string
  minuto: number | null
  es_penalty: boolean
  es_propia_meta: boolean
}

interface JugadorJSON {
  nombre: string
  nombre_completo: string
  titular: boolean
  convocado: boolean
  minuto_entrada: number | null
  minuto_salida: number | null
  goles_a_favor: number | null
  goles_en_contra: number | null
  tarjetas?: string[]
}

interface EquipoJSON {
  equipo: string
  jugadores: JugadorJSON[]
}

interface PartidoJSON {
  url: string
  equipos: EquipoJSON[]
  goles: { equipo: string; goles: GolJSON[] }[]
}

interface JornadaJSON {
  jornada: string
  partidos: PartidoJSON[]
}

// ── Helpers ───────────────────────────────────────────────────

function minutosJugados(j: JugadorJSON): number {
  if (j.minuto_entrada === null) return 0
  return (j.minuto_salida ?? 90) - j.minuto_entrada
}

function calcularResultado(golesFavor: number, golesContra: number): ResultadoPartido {
  if (golesFavor > golesContra) return 'VICTORIA'
  if (golesFavor < golesContra) return 'DERROTA'
  return 'EMPATE'
}

// ── Main ──────────────────────────────────────────────────────

async function main() {
  const pool = mysql.createPool({ uri: process.env.DATABASE_URL!, charset: 'utf8mb4' })
  const db = drizzle(pool, { schema, mode: 'default' })

  // Cargar aliases de BD y construir mapas invertidos
  const aliasesEquipo = await db
    .select({ alias: schema.aliasEquipo.alias, equipo: schema.equipo })
    .from(schema.aliasEquipo)
    .innerJoin(schema.equipo, eq(schema.aliasEquipo.equipoId, schema.equipo.id))

  mapaAliasEquipos = new Map(
    aliasesEquipo.map(r => [normalizar(r.alias), normalizar(r.equipo.nombre)])
  )

  const aliasesJugador = await db
    .select({ alias: schema.aliasJugador.alias, jugador: schema.jugador })
    .from(schema.aliasJugador)
    .innerJoin(schema.jugador, eq(schema.aliasJugador.jugadorId, schema.jugador.id))

  mapaAliasJugadores = new Map(
    aliasesJugador.map(r => [normalizar(r.alias), normalizar(r.jugador.nombreCompleto)])
  )

  console.log(`Aliases cargados: ${mapaAliasEquipos.size} equipos, ${mapaAliasJugadores.size} jugadores`)

  const raw = fs.readFileSync(JSON_PATH, 'utf-8')
  const data: JornadaJSON = JSON.parse(raw)

  // Extraer número de jornada del texto ("JORNADA 1" -> 1)
  const matchNum = data.jornada.match(/(\d+)/)
  const numJornada = matchNum ? parseInt(matchNum[1]) : 1
  console.log(`Importando: ${data.jornada} (num ${numJornada}) — ${data.partidos.length} partidos`)

  // Crear jornada si no existe
  let [jornadaRow] = await db
    .select()
    .from(schema.jornada)
    .where(and(
      eq(schema.jornada.division, DIVISION),
      eq(schema.jornada.numJornada, numJornada),
    ))
    .limit(1)

  if (!jornadaRow) {
    const id = uuid()
    await db.insert(schema.jornada).values({
      id,
      division: DIVISION,
      numJornada,
      fechaCierre: new Date(),
    })
    ;[jornadaRow] = await db.select().from(schema.jornada).where(eq(schema.jornada.id, id)).limit(1)
    console.log(`  Jornada creada: id=${jornadaRow.id}`)
  } else {
    console.log(`  Jornada existente: id=${jornadaRow.id}`)
  }

  let totalOk = 0
  let totalNoEncontrado = 0

  for (const [pIdx, partido] of data.partidos.entries()) {
    console.log(`\n--- Partido ${pIdx + 1}: ${partido.url}`)

    for (const [eIdx, equipoJSON] of partido.equipos.entries()) {
      const golesEquipo   = partido.goles[eIdx]?.goles ?? []
      const golesRival    = partido.goles[1 - eIdx]?.goles ?? []

      const totalFavor    = golesEquipo.length
      const totalContra   = golesRival.length

      // Buscar equipo en BD con aliases + matching flexible
      const todosEquipos = await db.select().from(schema.equipo).where(eq(schema.equipo.division, DIVISION))
      const nombreNorm = resolverEquipo(equipoJSON.equipo)

      const equipoBD =
        // 1. Exacto (o resuelto por alias)
        todosEquipos.find(e => normalizar(e.nombre) === nombreNorm) ??
        // 2. Uno contiene al otro
        todosEquipos.find(e => {
          const n = normalizar(e.nombre)
          return n.includes(nombreNorm) || nombreNorm.includes(n)
        }) ??
        // 3. Mayoría de palabras en común (al menos 2)
        todosEquipos.find(e => {
          const palabrasBD      = new Set(normalizar(e.nombre).split(' ').filter(p => p.length > 2))
          const palabrasScraper = nombreNorm.split(' ').filter(p => p.length > 2)
          const comunes = palabrasScraper.filter(p => palabrasBD.has(p))
          return comunes.length >= 2
        })

      if (!equipoBD) {
        console.warn(`  [!] Equipo no encontrado en BD: "${equipoJSON.equipo}"`)
        console.warn(`      Equipos disponibles: ${todosEquipos.map(e => e.nombre).join(', ')}`)
        continue
      }
      console.log(`  Equipo: "${equipoBD.nombre}" (id=${equipoBD.id})`)

      // Cargar todos los jugadores activos de este equipo con su jugador
      const jeRows = await db
        .select({
          je: schema.jugadorEquipo,
          jug: schema.jugador,
        })
        .from(schema.jugadorEquipo)
        .innerJoin(schema.jugador, eq(schema.jugadorEquipo.jugadorId, schema.jugador.id))
        .where(and(
          eq(schema.jugadorEquipo.equipoId, equipoBD.id),
          eq(schema.jugadorEquipo.activo, true),
        ))

      for (const jugadorJSON of equipoJSON.jugadores) {
        const nombreBuscado     = resolverJugador(jugadorJSON.nombre_completo)
        const consonantesBuscado = consonantes(nombreBuscado)

        // 1. Exacto normalizado (con aliases)
        // 2. Consonantes (sin vocales, sin tildes, Ñ→N)
        const coincidencia =
          jeRows.find(r => normalizar(r.jug.nombreCompleto) === nombreBuscado) ??
          jeRows.find(r => consonantes(normalizar(r.jug.nombreCompleto)) === consonantesBuscado)

        if (!coincidencia) {
          console.warn(`    [!] No encontrado: "${jugadorJSON.nombre_completo}" (consonantes: ${consonantesBuscado})`)
          const tarjetasSR        = jugadorJSON.tarjetas ?? []
          const golesAnotadosSR   = (partido.goles[eIdx]?.goles ?? []).filter(
            g => normalizar(g.jugador_completo) === nombreBuscado && !g.es_propia_meta
          )
          const golesPropiaSR = (partido.goles[1 - eIdx]?.goles ?? []).filter(
            g => normalizar(g.jugador_completo) === nombreBuscado && g.es_propia_meta
          ).length
          try {
            await db.insert(schema.estadisticaJornadaSinRegistrar).values({
              id:                    uuid(),
              jornadaId:             jornadaRow.id,
              equipoId:              equipoBD.id,
              nombreEquipoScraper:   equipoJSON.equipo,
              nombreJugadorScraper:  jugadorJSON.nombre,
              nombreCompletoScraper: jugadorJSON.nombre_completo,
              convocado:             jugadorJSON.convocado,
              titular:               jugadorJSON.titular,
              minutosJugados:        minutosJugados(jugadorJSON),
              goles:                 golesAnotadosSR.length,
              golesDePenalti:        golesAnotadosSR.filter(g => g.es_penalty).length,
              tarjetasAmarillas:     tarjetasSR.filter(t => t === 'yellow').length,
              tarjetaRoja:           tarjetasSR.includes('red'),
              resultado:             calcularResultado(totalFavor, totalContra),
              golesEncajados:        jugadorJSON.goles_en_contra ?? 0,
              golesAFavor:           jugadorJSON.goles_a_favor ?? 0,
              golEnPropia:           golesPropiaSR,
              diferenciaGoles:       totalFavor - totalContra,
              creadoEn:              new Date(),
            })
          } catch (_) { /* ignora duplicados */ }
          totalNoEncontrado++
          continue
        }

        const { je } = coincidencia

        // Goles anotados por este jugador (en la lista de su equipo, no en propia)
        const golesAnotados = golesEquipo.filter(
          g => normalizar(g.jugador_completo) === nombreBuscado && !g.es_propia_meta
        )
        const goles         = golesAnotados.length
        const golesPenalti  = golesAnotados.filter(g => g.es_penalty).length

        // Goles en propia (aparecen en la lista del equipo rival)
        const golesPropia = golesRival.filter(
          g => normalizar(g.jugador_completo) === nombreBuscado && g.es_propia_meta
        ).length

        // Tarjetas
        const tarjetas        = jugadorJSON.tarjetas ?? []
        const tarjetasAmarillas = tarjetas.filter(t => t === 'yellow').length
        const tarjetaRoja       = tarjetas.includes('red')

        // Minutos
        const minutos = minutosJugados(jugadorJSON)

        // Resultado desde la perspectiva de este equipo
        const resultado = jugadorJSON.minuto_entrada !== null
          ? calcularResultado(totalFavor, totalContra)
          : calcularResultado(totalFavor, totalContra) // suplente igualmente lleva resultado

        const diferencia = totalFavor - totalContra

        // Insertar o ignorar si ya existe
        try {
          await db.insert(schema.estadisticaJornada).values({
            id: uuid(),
            jornadaId:        jornadaRow.id,
            jugadorEquipoId:  je.id,
            convocado:        jugadorJSON.convocado,
            titular:          jugadorJSON.titular,
            minutosJugados:   minutos,
            goles,
            golesDePenalti:   golesPenalti,
            tarjetasAmarillas,
            tarjetaRoja,
            resultado,
            golesEncajados:   jugadorJSON.goles_en_contra ?? 0,
            golesAFavor:      jugadorJSON.goles_a_favor ?? 0,
            golEnPropia:      golesPropia,
            diferenciaGoles:  diferencia,
            puntosCalculados: 0,
          })
          console.log(`    OK: ${jugadorJSON.nombre} (${minutos}min, ${goles}gol, ${tarjetasAmarillas}am)`)
          totalOk++
        } catch (e: any) {
          if (e?.code === 'ER_DUP_ENTRY') {
            console.warn(`    [dup] Ya existe: ${jugadorJSON.nombre}`)
          } else {
            throw e
          }
        }
      }
    }
  }

  await db.update(schema.jornada)
    .set({ statsImportadas: true })
    .where(eq(schema.jornada.id, jornadaRow.id))

  console.log(`\nFin: ${totalOk} registros insertados, ${totalNoEncontrado} jugadores no encontrados`)
  await pool.end()
}

main().catch(e => { console.error(e); process.exit(1) })
