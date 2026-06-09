/**
 * Scraper de estadísticas desde euskadifutbol.eus
 *
 * Uso:
 *   npx ts-node -P tsconfig.scripts.json prisma/scraper-estadisticas.ts <jornadaId> <url-jornada>
 *
 * Ejemplo:
 *   npx ts-node -P tsconfig.scripts.json prisma/scraper-estadisticas.ts \
 *     "uuid-de-jornada" \
 *     "https://www.euskadifutbol.eus/pnfg/NPcd/NFG_CmpJornada?cod_primaria=3001885&CodCompeticion=22619984&..."
 */

import https from 'https'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import dotenv from 'dotenv'
import path from 'path'

dotenv.config({ path: path.resolve(__dirname, '../.env') })

const DB_URL = process.env.DATABASE_URL ?? 'postgresql://fantasy_user:fantasy_pass@localhost:5432/fantasy_futbol'
const adapter = new PrismaPg({ connectionString: DB_URL })
const prisma = new PrismaClient({ adapter })
const BASE = 'https://www.euskadifutbol.eus'

// ─── HTTP ──────────────────────────────────────────────────────────────────────

let sessionCookie = ''

async function fetchHtml(url: string, redirects = 5): Promise<string> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'GET',
        rejectUnauthorized: false,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9',
          'Accept-Language': 'es-ES,es;q=0.9',
          ...(sessionCookie ? { Cookie: sessionCookie } : {}),
        },
      },
      res => {
        for (const c of res.headers['set-cookie'] ?? []) {
          const m = c.match(/^([^=]+)=([^;]+)/)
          if (m) { sessionCookie = `${m[1]}=${m[2]}`; break }
        }
        // Seguir redirecciones (302, 301...)
        const location = res.headers['location']
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && location && redirects > 0) {
          const next = location.startsWith('http') ? location : `${BASE}${location}`
          resolve(fetchHtml(next, redirects - 1))
          res.resume()
          return
        }
        const chunks: Buffer[] = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => resolve(Buffer.concat(chunks).toString('latin1')))
      }
    )
    req.on('error', reject)
    req.end()
  })
}

// ─── NORMALIZACIÓN ─────────────────────────────────────────────────────────────

function norm(s: string): string {
  return s
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // quitar tildes
    .toLowerCase()
    .replace(/[.,\-']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Sufijos legales y palabras genéricas de nombres de equipo
const TEAM_NOISE = [
  /\bs\.?\s*a\.?\s*d\.?\b/gi,  // SAD / S.A.D.
  /\bc\.?\s*d\.?\b/gi,          // CD / C.D.
  /\bs\.?\s*d\.?\b/gi,          // SD / S.D.
  /\bs\.?\s*l\.?\b/gi,          // SL / S.L.
  /\bf\.?\s*c\.?\b/gi,          // FC / F.C.
  /\bs\.\s*$/gi,                 // "S." al final (ej: "DURANGO, S.")
  /\bclub\b/gi,
  /\bdeportivo\b/gi,
  /\bdeportes\b/gi,
  /\bcultural\b/gi,
  /\bathletic[s]?\b/gi,
  /\bdpva\b/gi,   // Diputación Provincial de Álava
  /\bkirolak\b/gi,
  /\bfutbol\b/gi,
  /\bfútbol\b/gi,
  /\bsociedad\b/gi,
  /\banonima\b/gi,
]

function normTeam(name: string): string {
  let n = name
  for (const re of TEAM_NOISE) n = n.replace(re, ' ')
  return norm(n)
}

/**
 * Puntuación de similitud entre dos nombres de jugador (0..1).
 * Maneja el formato "APELLIDO APELLIDO, NOMBRE" de la federación
 * comparando tokens sin importar el orden.
 */
function nameScore(fedName: string, dbName: string): number {
  const toks = (s: string) =>
    new Set(norm(s.replace(',', ' ')).split(' ').filter(t => t.length > 1))
  const a = toks(fedName)
  const b = toks(dbName)
  let common = 0
  for (const t of a) if (b.has(t)) common++
  const denom = Math.max(a.size, b.size)
  return denom > 0 ? common / denom : 0
}

// ─── TIPOS DE DATOS ────────────────────────────────────────────────────────────

interface FedPlayer {
  dorsal: number
  nombre: string // formato "APELLIDO APELLIDO, NOMBRE"
  fedId: string  // ID interno de la federación
}

interface Sustitucion {
  entra: string
  sale: string
  minuto: number
}

interface Gol {
  jugador: string
  propia: boolean
  minuto: number
}

interface Tarjeta {
  jugador: string
  roja: boolean
  minuto: number
}

interface EquipoPartido {
  nombre: string
  titulares: FedPlayer[]
  banco: FedPlayer[]
  sustituciones: Sustitucion[]
  tarjetas: Tarjeta[]
}

interface DatosPartido {
  local: EquipoPartido
  visitante: EquipoPartido
  goles: Gol[]
}

// ─── PARSEO HTML ───────────────────────────────────────────────────────────────

/** Extrae jugadores de un bloque HTML (sección titulares u ordezkoak) */
function extraerJugadores(bloque: string): FedPlayer[] {
  const jugadores: FedPlayer[] = []
  // Cada fila: onclick con jugador=ID, primer td = dorsal, segundo td = nombre
  const reRow = /onclick="location\.href='[^']*jugador=(\d+)[^'"]*'"[\s\S]*?<td[^>]*>\s*(\d+)\s*<\/td>[\s\S]*?<td[^>]*>\s*([^<\n]+?)\s*<\/td>/g
  let m: RegExpExecArray | null
  while ((m = reRow.exec(bloque)) !== null) {
    const nombre = m[3].replace(/&nbsp;/g, ' ').trim()
    if (nombre) jugadores.push({ fedId: m[1], dorsal: parseInt(m[2]), nombre })
  }
  return jugadores
}

/** Extrae sustituciones de una sección Ordezkapenak */
function extraerSustituciones(bloque: string): Sustitucion[] {
  const subs: Sustitucion[] = []
  // Cada sustitución: una tabla con 2 filas.
  // Fila 0: jugador que entra (arrow-left)
  // Fila 1: jugador que sale con minuto (arrow-right)
  const reTables = /<table[^>]*class="table table-striped table-hover"[^>]*>([\s\S]*?)<\/table>/g
  let tbl: RegExpExecArray | null
  while ((tbl = reTables.exec(bloque)) !== null) {
    const inner = tbl[1]
    if (!inner.includes('fa-arrow-left') && !inner.includes('fa-arrow-right')) continue

    const filas = [...inner.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(r => r[1])
    if (filas.length < 2) continue

    // Nombre del que entra: segunda celda de la fila 0
    const celdas0 = [...filas[0].matchAll(/<td[^>]*>\s*([\s\S]*?)\s*<\/td>/g)].map(c =>
      c[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim()
    )
    const entra = celdas0[1]?.trim()

    // Minuto y nombre del que sale: segunda celda de la fila 1
    const celda1 = filas[1].match(/<td[^>]*>\s*<p[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? ''
    const minMatch = celda1.match(/\((\d+)'?\)/)
    const sale = celda1.replace(/<[^>]+>/g, '').replace(/&[^;]+;/g, ' ').replace(/\(\d+'\)/, '').trim()

    if (entra && sale && minMatch) {
      subs.push({ entra, sale, minuto: parseInt(minMatch[1]) })
    }
  }
  return subs
}

/** Extrae tarjetas de una sección Txartelak */
function extraerTarjetas(bloque: string): Tarjeta[] {
  const tarjetas: Tarjeta[] = []
  const reRow = /<tr>[\s\S]*?<img[^>]+src="([^"]*tarj_[^"]+)"[\s\S]*?<span[^>]*>\((\d+)'?\)<\/span>\s*([^<]+?)\s*<\/td>/g
  let m: RegExpExecArray | null
  while ((m = reRow.exec(bloque)) !== null) {
    const src = m[1]
    const roja = src.includes('tarj_roja') || src.includes('tarj_azul') // roja o azul = expulsión
    tarjetas.push({ jugador: m[3].trim(), minuto: parseInt(m[2]), roja })
  }
  return tarjetas
}

/** Extrae goles de la sección Golak */
function extraerGoles(bloque: string): Gol[] {
  const goles: Gol[] = []
  // Cada gol: título del enlace (tipo) + minuto + nombre
  const reRow = /<a[^>]+title="([^"]*)"[^>]*>[\s\S]*?<span[^>]*>\((\d+)'?\)<\/span>\s*([^<]+?)\s*<\/td>/g
  let m: RegExpExecArray | null
  while ((m = reRow.exec(bloque)) !== null) {
    const titulo = m[1].toLowerCase()
    const propia = titulo.includes('bere atean') || titulo.includes('propia')
    goles.push({ jugador: m[3].trim(), minuto: parseInt(m[2]), propia })
  }
  return goles
}

/** Parsea el HTML completo de un partido */
function parsearPartido(html: string): DatosPartido | null {
  // Nombres de equipos en las cabeceras de columna
  const nomLocal = html.match(/<div class=font_widgetL>\s*([^<]+?)\s*<\/div>/)?.[1]?.trim()
  const nomVisitante = html.match(/<div class=font_widgetV>\s*([^<]+?)\s*<\/div>/)?.[1]?.trim()
  if (!nomLocal || !nomVisitante) return null

  // Sección de goles (antes de las alineaciones)
  const secGoles = html.match(/Golak<\/div>([\s\S]*?)<div class=number/)?.[1] ?? ''

  // Dividir el HTML en los dos bloques de equipo (cada uno empieza con <div class=number>)
  const partes = html.split(/<div class=number[^>]*>/)
  // partes[0] = encabezado, partes[1] = local, partes[2] = visitante (aproximadamente)
  // Buscamos la parte que empieza con el nombre del equipo
  const bloqueLocal = partes.find(p => p.trimStart().startsWith(nomLocal.substring(0, 12))) ?? ''
  const bloqueVisitante = partes.find(p => p.trimStart().startsWith(nomVisitante.substring(0, 12))) ?? ''

  const parsearEquipo = (bloque: string, nombre: string): EquipoPartido => {
    const secTitulares = bloque.match(/<strong>Titularrak<\/strong>[\s\S]*?<\/table>/)?.[0] ?? ''
    const secBanco = bloque.match(/<strong>Ordezkoak<\/strong>[\s\S]*?<\/table>/)?.[0] ?? ''
    const secSubs = bloque.match(/Ordezkapenak<\/h4>([\s\S]*?)(?=<h4|<\/div>\s*<\/div>)/)?.[1] ?? ''
    const secTarjetas = bloque.match(/Txartelak<\/h4>([\s\S]*?)(?=<h4|<\/div>\s*<\/div>)/)?.[1] ?? ''

    return {
      nombre,
      titulares: extraerJugadores(secTitulares),
      banco: extraerJugadores(secBanco),
      sustituciones: extraerSustituciones(secSubs),
      tarjetas: extraerTarjetas(secTarjetas),
    }
  }

  return {
    local: parsearEquipo(bloqueLocal, nomLocal),
    visitante: parsearEquipo(bloqueVisitante, nomVisitante),
    goles: extraerGoles(secGoles),
  }
}

/** Extrae los links de partidos de una página de jornada */
function extraerLinksPartidos(html: string): string[] {
  const links = new Set<string>()
  const re = /href="(\/pnfg\/NPcd\/NFG_CmpPartido\?[^"]+)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) links.add(m[1])
  return [...links]
}

// ─── MATCHING CON LA BASE DE DATOS ─────────────────────────────────────────────

type JugadorEquipoConJugador = {
  id: string
  jugador: { id: string; nombreCompleto: string; nombre: string }
}

/** Busca el Equipo en la BD por nombre normalizado. Devuelve null si no lo encuentra. */
async function matchEquipo(
  nombreFed: string,
  division: string
): Promise<{ id: string; nombre: string } | null> {
  const equipos = await prisma.equipo.findMany({ where: { division: division as any } })
  const target = normTeam(nombreFed)

  let best: { id: string; nombre: string } | null = null
  let bestScore = 0

  for (const eq of equipos) {
    const score = nameScore(target, normTeam(eq.nombre))
    if (score > bestScore) { bestScore = score; best = eq }
  }

  // Umbral mínimo del 40% de tokens en común
  return bestScore >= 0.4 ? best : null
}

/** Busca el JugadorEquipo (activo) que mejor encaja con el nombre de la federación */
function matchJugador(
  nombreFed: string,
  plantilla: JugadorEquipoConJugador[]
): { je: JugadorEquipoConJugador; score: number } | null {
  let best: JugadorEquipoConJugador | null = null
  let bestScore = 0

  for (const je of plantilla) {
    const s1 = nameScore(nombreFed, je.jugador.nombreCompleto)
    const s2 = nameScore(nombreFed, je.jugador.nombre)
    const score = Math.max(s1, s2)
    if (score > bestScore) { bestScore = score; best = je }
  }

  return best && bestScore >= 0.5 ? { je: best, score: bestScore } : null
}

// ─── CÁLCULO DE MINUTOS ─────────────────────────────────────────────────────────

function calcularMinutos(
  nombreFed: string,
  esTitular: boolean,
  sustituciones: Sustitucion[],
  duracionPartido = 90
): number {
  for (const sub of sustituciones) {
    // ¿El jugador fue sustituido (sale)?
    if (nameScore(nombreFed, sub.sale) >= 0.7) {
      return esTitular ? sub.minuto : 0
    }
    // ¿El jugador entró como sustituto?
    if (nameScore(nombreFed, sub.entra) >= 0.7) {
      return duracionPartido - sub.minuto
    }
  }

  return esTitular ? duracionPartido : 0
}

// ─── PROCESO PRINCIPAL ─────────────────────────────────────────────────────────

async function procesarPartido(
  urlPartido: string,
  jornadaId: string,
  division: string
) {
  const html = await fetchHtml(`${BASE}${urlPartido}`)
  const datos = parsearPartido(html)

  if (!datos) {
    console.warn(`  ⚠️  No se pudo parsear: ${urlPartido}`)
    return { ok: 0, noMatch: [] as string[] }
  }

  const equipoLocalBD = await matchEquipo(datos.local.nombre, division)
  const equipoVisitanteBD = await matchEquipo(datos.visitante.nombre, division)

  if (!equipoLocalBD) {
    console.warn(`  ⚠️  Equipo local no encontrado en BD: "${datos.local.nombre}"`)
  }
  if (!equipoVisitanteBD) {
    console.warn(`  ⚠️  Equipo visitante no encontrado en BD: "${datos.visitante.nombre}"`)
  }

  let ok = 0
  const noMatch: string[] = []

  for (const [equipoFed, equipoBD] of [
    [datos.local, equipoLocalBD],
    [datos.visitante, equipoVisitanteBD],
  ] as [EquipoPartido, { id: string; nombre: string } | null][]) {
    if (!equipoBD) continue

    // Plantilla activa en nuestra BD para este equipo
    const plantilla: JugadorEquipoConJugador[] = await prisma.jugadorEquipo.findMany({
      where: { equipoId: equipoBD.id, activo: true },
      include: { jugador: { select: { id: true, nombreCompleto: true, nombre: true } } },
    })

    // Resultado del equipo (contamos goles de la lista de goles)
    const todosLosFed = [...equipoFed.titulares, ...equipoFed.banco]

    let golesAFavor = 0
    let golesEnContra = 0
    for (const gol of datos.goles) {
      const esDeEsteEquipo = todosLosFed.some(p => nameScore(gol.jugador, p.nombre) >= 0.7)
      if (gol.propia) {
        if (esDeEsteEquipo) golesEnContra++ // propia puerta → en contra
        else golesAFavor++
      } else {
        if (esDeEsteEquipo) golesAFavor++
        else golesEnContra++
      }
    }

    const resultado =
      golesAFavor > golesEnContra ? 'VICTORIA' :
      golesAFavor < golesEnContra ? 'DERROTA' : 'EMPATE'

    // Procesar cada jugador del equipo (titulares + banco)
    for (const jugFed of todosLosFed) {
      const esTitular = equipoFed.titulares.some(t => t.fedId === jugFed.fedId)
      const match = matchJugador(jugFed.nombre, plantilla)

      if (!match) {
        noMatch.push(`${equipoFed.nombre} | ${jugFed.nombre}`)
        continue
      }

      const { je } = match
      const minutos = calcularMinutos(jugFed.nombre, esTitular, equipoFed.sustituciones)

      // Goles del jugador (solo los propios, no los en propia puerta)
      const golesJug = datos.goles.filter(
        g => !g.propia && nameScore(g.jugador, jugFed.nombre) >= 0.7
      ).length

      // Tarjetas
      const tarjetasJug = equipoFed.tarjetas.filter(
        t => nameScore(t.jugador, jugFed.nombre) >= 0.7
      )
      const amarillas = tarjetasJug.filter(t => !t.roja).length
      const tieneRoja  = tarjetasJug.some(t => t.roja)

      try {
        await prisma.estadisticaJornada.upsert({
          where: { jornadaId_jugadorEquipoId: { jornadaId, jugadorEquipoId: je.id } },
          create: {
            jornadaId,
            jugadorEquipoId: je.id,
            convocado: true,
            titular: esTitular,
            minutosJugados: minutos,
            goles: golesJug,
            tarjetasAmarillas: amarillas,
            tarjetaRoja: tieneRoja,
            resultado: resultado as any,
            puntosCalculados: 0, // se calcula después con el endpoint de admin
          },
          update: {
            convocado: true,
            titular: esTitular,
            minutosJugados: minutos,
            goles: golesJug,
            tarjetasAmarillas: amarillas,
            tarjetaRoja: tieneRoja,
            resultado: resultado as any,
            puntosCalculados: 0,
          },
        })
        ok++
      } catch (e: any) {
        console.error(`  ✗ Error guardando ${jugFed.nombre}: ${e.message}`)
      }
    }
  }

  const marcador = `${datos.local.nombre} vs ${datos.visitante.nombre}`
  console.log(`  ✓ ${marcador} — ${ok} jugadores guardados`)
  if (noMatch.length) {
    console.warn(`    Sin match (${noMatch.length}):`)
    for (const nm of noMatch) console.warn(`      - ${nm}`)
  }

  return { ok, noMatch }
}

async function main() {
  const [jornadaId, jornadaUrl] = process.argv.slice(2)

  if (!jornadaId || !jornadaUrl) {
    console.error('Uso: scraper-estadisticas.ts <jornadaId> <url-jornada>')
    process.exit(1)
  }

  const jornada = await prisma.jornada.findUnique({ where: { id: jornadaId } })
  if (!jornada) {
    console.error(`Jornada ${jornadaId} no encontrada en la base de datos`)
    process.exit(1)
  }

  console.log(`\n🏟  Jornada ${jornada.numJornada} — ${jornada.division}`)
  console.log(`📡 Obteniendo sesión...`)
  await fetchHtml(`${BASE}/pnfg`)

  console.log(`📋 Descargando página de jornada...`)
  const htmlJornada = await fetchHtml(jornadaUrl)
  const links = extraerLinksPartidos(htmlJornada)

  if (!links.length) {
    console.error('No se encontraron partidos en la URL indicada')
    process.exit(1)
  }

  console.log(`⚽ ${links.length} partidos encontrados\n`)

  let totalOk = 0
  const totalNoMatch: string[] = []

  for (const link of links) {
    const { ok, noMatch } = await procesarPartido(link, jornadaId, jornada.division)
    totalOk += ok
    totalNoMatch.push(...noMatch)
    await new Promise(r => setTimeout(r, 500)) // pausa entre peticiones
  }

  console.log(`\n✅ Completado: ${totalOk} estadísticas guardadas`)

  if (totalNoMatch.length) {
    console.warn(`\n⚠️  ${totalNoMatch.length} jugadores sin coincidencia en la BD:`)
    for (const nm of totalNoMatch) console.warn(`  - ${nm}`)
    console.warn('\nComprueba los nombres en el panel de admin y vuelve a ejecutar.')
  }

  console.log('\nRecuerda ejecutar "Calcular puntuaciones" en el panel de admin para esta jornada.')
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
