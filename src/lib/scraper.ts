// @ts-nocheck
import * as cheerio from 'cheerio'
import https from 'https'
import http from 'http'

// ── Tipos ───────────────────────────────────────────────────────

export interface GolScraped {
  jugador: string
  jugador_completo: string
  minuto: number | null
  es_penalty: boolean
  es_propia_meta: boolean
}

export interface JugadorScraped {
  nombre: string
  nombre_completo: string
  titular: boolean
  convocado: boolean
  minuto_entrada: number | null
  minuto_salida: number | null
  goles_a_favor: number | null
  goles_en_contra: number | null
  resultado?: string
  tarjetas?: string[]
}

export interface EquipoScraped {
  equipo: string
  jugadores: JugadorScraped[]
}

export interface PartidoScraped {
  url: string
  equipos: EquipoScraped[]
  goles: { equipo: string; goles: GolScraped[] }[]
}

export interface JornadaScraped {
  jornada: string
  partidos: PartidoScraped[]
}

// ── FlareSolverr ────────────────────────────────────────────────

async function flareSolveOnce(url: string): Promise<string> {
  const flareUrl = process.env.FLARESOLVERR_URL
  if (!flareUrl) throw new Error('FLARESOLVERR_URL no configurada')

  const body = JSON.stringify({ cmd: 'request.get', url, maxTimeout: 60000 })
  const parsed = new URL(flareUrl + '/v1')
  const lib = parsed.protocol === 'https:' ? https : http

  return new Promise((resolve, reject) => {
    const req = lib.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try {
          const json = JSON.parse(data)
          if (json.status !== 'ok') reject(new Error(`FlareSolverr error: ${json.message}`))
          else resolve(json.solution.response as string)
        } catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

async function flareSolve(url: string, intentos = 3): Promise<string> {
  for (let i = 1; i <= intentos; i++) {
    try {
      return await flareSolveOnce(url)
    } catch (e: any) {
      console.warn(`[SCRAPER] FlareSolverr intento ${i}/${intentos} fallido: ${e.message}`)
      if (i === intentos) throw e
      await new Promise(r => setTimeout(r, 3000 * i))
    }
  }
  throw new Error('FlareSolverr: máximo de reintentos alcanzado')
}

// ── Helpers ──────────────────────────────────────────────────────

function nombresDesdeTd($: cheerio.CheerioAPI, td: cheerio.Cheerio<any>): { nombre: string; nombreCompleto: string } {
  const spans = td.find('a span')
  if (spans.length >= 2) return { nombre: $(spans[0]).text().trim(), nombreCompleto: $(spans[1]).text().trim() }
  if (spans.length === 1) { const n = $(spans[0]).text().trim(); return { nombre: n, nombreCompleto: n } }
  const n = td.text().trim(); return { nombre: n, nombreCompleto: n }
}

function extraerEquipo($: cheerio.CheerioAPI, tabla: cheerio.Cheerio<any>): { nombreEquipo: string; jugadores: JugadorScraped[] } {
  let nombreEquipo = 'DESCONOCIDO'
  const jugadores: JugadorScraped[] = []
  let seccion: 'titulares' | 'suplentes' | null = null
  let ultimoTitularIdx: number | null = null

  tabla.find('tr').each((_, tr) => {
    const th = $(tr).find('th')
    if (th.length) {
      const texto = th.text().trim()
      if (/CUERPO.?TÉCNICO/i.test(texto)) return false
      if (/TITULARES/i.test(texto)) { seccion = 'titulares'; nombreEquipo = texto.replace(/^TITULARES\s*/i, '').trim() }
      else if (/SUPLENTES/i.test(texto)) { seccion = 'suplentes' }
      return
    }
    if (!seccion) return
    const tdNombre = $(tr).find('td#tdJugadorAlineado')
    if (!tdNombre.length) return
    const { nombre, nombreCompleto } = nombresDesdeTd($, tdNombre)
    if (!nombre) return
    const imgSust = $(tr).find('img#imgSustitucion')
    if (seccion === 'titulares') {
      if (imgSust.length) {
        const m = /(\d+)/.exec(imgSust.attr('title') ?? '')
        const minuto = m ? parseInt(m[1]) : null
        if (ultimoTitularIdx !== null) { jugadores[ultimoTitularIdx].minuto_salida = minuto; ultimoTitularIdx = null }
        jugadores.push({ nombre, nombre_completo: nombreCompleto, titular: false, convocado: true, minuto_entrada: minuto, minuto_salida: 90, goles_a_favor: null, goles_en_contra: null })
      } else {
        jugadores.push({ nombre, nombre_completo: nombreCompleto, titular: true, convocado: true, minuto_entrada: 0, minuto_salida: 90, goles_a_favor: null, goles_en_contra: null })
        ultimoTitularIdx = jugadores.length - 1
      }
    } else {
      if (!jugadores.some(j => j.nombre_completo === nombreCompleto)) {
        jugadores.push({ nombre, nombre_completo: nombreCompleto, titular: false, convocado: true, minuto_entrada: null, minuto_salida: null, goles_a_favor: null, goles_en_contra: null })
      }
    }
  })
  return { nombreEquipo, jugadores }
}

function extraerGoles($: cheerio.CheerioAPI, div: cheerio.Cheerio<any>): { equipo: string; goles: GolScraped[] }[] {
  const resultado: { equipo: string; goles: GolScraped[] }[] = []
  div.find('table.datosPartido').each((_, tabla) => {
    const th = $(tabla).find('th').first()
    if (!th.length || !/GOLEADORES/i.test(th.text())) return
    const nombreEquipo = th.text().trim().replace(/^GOLEADORES\s*/i, '').trim()
    const goles: GolScraped[] = []
    $(tabla).find('tr').each((_, tr) => {
      const tdJ = $(tr).find('td#tdJugadorAlineado')
      const tdR = $(tr).find('td#tdResultadoParcial')
      if (!tdJ.length || !tdR.length) return
      const { nombre, nombreCompleto } = nombresDesdeTd($, tdJ)
      const parrafos = tdR.find('p')
      let minuto: number | null = null
      if (parrafos.length >= 2) { const m = /(\d+)/.exec($(parrafos[1]).text().trim()); if (m) minuto = parseInt(m[1]) }
      const imgs = tdJ.find('img')
      const esPenalty = imgs.toArray().some(i => /penalti/i.test($(i).attr('title') ?? ''))
      const esPropia  = imgs.toArray().some(i => /propia meta/i.test($(i).attr('title') ?? ''))
      goles.push({ jugador: nombre, jugador_completo: nombreCompleto, minuto, es_penalty: esPenalty, es_propia_meta: esPropia })
    })
    resultado.push({ equipo: nombreEquipo, goles })
  })
  return resultado
}

function extraerTarjetas($: cheerio.CheerioAPI, div: cheerio.Cheerio<any>, equipos: { jugadores: JugadorScraped[] }[]) {
  const tablas = div.find('table.datosPartido').toArray()
    .filter(t => $(t).attr('id') !== 'tableArbitroPartido')
    .filter(t => /TARJETAS/i.test($(t).find('th').first().text()))
  tablas.forEach((tabla, i) => {
    const indice = new Map(equipos[i]?.jugadores.map(j => [j.nombre_completo, j]) ?? [])
    $(tabla).find('tr').each((_, tr) => {
      const tdJ = $(tr).find('td#tdJugadorAlineado')
      const tdT = $(tr).find('td#tdDatosTarjeta')
      if (!tdJ.length || !tdT.length) return
      const { nombreCompleto } = nombresDesdeTd($, tdJ)
      const imgs = tdT.find('img')
      const nAm = imgs.toArray().filter(i => ($(i).attr('src') ?? '').toLowerCase().includes('yellow')).length
      const nRo = imgs.toArray().filter(i => ($(i).attr('src') ?? '').toLowerCase().includes('red')).length
      const tarjetas = (nAm === 2 && nRo === 1) ? ['yellow', 'yellow'] : [...Array(nAm).fill('yellow'), ...Array(nRo).fill('red')]
      const jugador = indice.get(nombreCompleto)
      if (jugador && tarjetas.length > 0) jugador.tarjetas = [...(jugador.tarjetas ?? []), ...tarjetas]
    })
  })
}

function calcularGoles(equipos: { jugadores: JugadorScraped[] }[], golesEquipos: { goles: GolScraped[] }[]) {
  for (let i = 0; i < equipos.length; i++) {
    const gF = golesEquipos[i]?.goles ?? []
    const gC = golesEquipos[1 - i]?.goles ?? []
    const tF = gF.length, tC = gC.length
    const resultado = tF > tC ? 'VICTORIA' : tF < tC ? 'DERROTA' : 'EMPATE'
    for (const j of equipos[i].jugadores) {
      j.resultado = resultado
      if (j.minuto_entrada === null) { j.goles_a_favor = null; j.goles_en_contra = null; continue }
      const [en, sa] = [j.minuto_entrada, j.minuto_salida ?? 90]
      j.goles_a_favor  = gF.filter(g => g.minuto !== null && en <= g.minuto && g.minuto <= sa).length
      j.goles_en_contra = gC.filter(g => g.minuto !== null && en <= g.minuto && g.minuto <= sa).length
    }
  }
}

// ── Procesar partido ─────────────────────────────────────────────

async function procesarPartido(url: string, idx: number): Promise<PartidoScraped | null> {
  console.log(`[SCRAPER] Partido ${idx}: ${url}`)
  const html = await flareSolve(url)
  const $ = cheerio.load(html)

  if (!$('#divAlineacionesPartido').length) return null

  const equipos = $('#divAlineacionesPartido table[id^="tableAlineados"]').toArray()
    .map(t => { const { nombreEquipo, jugadores } = extraerEquipo($, $(t)); return { equipo: nombreEquipo, jugadores } })

  const divGoles = $('#divGoleadoresPartido')
  const golesEquipos = divGoles.length ? extraerGoles($, divGoles) : []
  if (golesEquipos.length === equipos.length) calcularGoles(equipos, golesEquipos)

  const divTarj = $('#divTarjetasPartido')
  if (divTarj.length) extraerTarjetas($, divTarj, equipos)

  return { url, equipos, goles: golesEquipos.map(g => ({ equipo: g.equipo, goles: g.goles })) }
}

// ── Export principal ────────────────────────────────────────────

export async function extraerJornada(urlCalendario: string, numJornada: number): Promise<JornadaScraped | null> {
  console.log(`[SCRAPER] Resolviendo calendario via FlareSolverr...`)
  const html = await flareSolve(urlCalendario)
  const $ = cheerio.load(html)
  console.log(`[SCRAPER] Calendario cargado. Buscando jornada ${numJornada}...`)

  const urlsJornada: string[] = []
  let nombreJornada: string | null = null

  $('#calendarContainer div[style*="display:flex"]').each((_, flexDiv) => {
    $(flexDiv).children().each((_, hijo) => {
      const th = $(hijo).find('table tr:first-child th')
      if (!th.length) return
      let textoTh = th.text().trim().replace('schedule', '').replace('get_app', '').trim()
      const mNum = /JORNADA\s+(\d+)/i.exec(textoTh)
      if (!mNum || parseInt(mNum[1]) !== numJornada) return
      nombreJornada = textoTh
      $(hijo).find('tr#filaPartido').each((_, fila) => {
        const onclick = $(fila).attr('onclick') ?? ''
        const m = /window\.location='([^']+)'/.exec(onclick)
        if (m) urlsJornada.push(`https://www.lapreferente.com/${m[1]}`)
      })
    })
  })

  if (!urlsJornada.length || !nombreJornada) {
    console.log(`[SCRAPER] No se encontraron partidos para jornada ${numJornada}`)
    return null
  }

  console.log(`[SCRAPER] ${nombreJornada} — ${urlsJornada.length} partidos`)

  const partidos: PartidoScraped[] = []
  for (let idx = 0; idx < urlsJornada.length; idx++) {
    const res = await procesarPartido(urlsJornada[idx], idx + 1)
    if (res) partidos.push(res)
  }

  return { jornada: nombreJornada, partidos }
}
