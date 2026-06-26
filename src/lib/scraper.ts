import { chromium } from 'playwright'

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

// ── Extracción en browser context ────────────────────────────────

async function procesarPartido(page: any, url: string, idx: number): Promise<PartidoScraped | null> {
  console.log(`[SCRAPER] Partido ${idx}: ${url}`)
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })

  const sinAlineaciones = await page.evaluate(() => !document.querySelector('#divAlineacionesPartido'))
  if (sinAlineaciones) return null

  // Un solo evaluate extrae todo: alineaciones, goles y tarjetas
  const data = await page.evaluate(() => {
    function nombresDesdeTd(td: Element): { nombre: string; nombreCompleto: string } {
      const spans = td.querySelectorAll('a span')
      if (spans.length >= 2) return { nombre: spans[0].textContent!.trim(), nombreCompleto: spans[1].textContent!.trim() }
      if (spans.length === 1) { const n = spans[0].textContent!.trim(); return { nombre: n, nombreCompleto: n } }
      const n = td.textContent!.trim(); return { nombre: n, nombreCompleto: n }
    }

    function extraerEquipo(tabla: Element) {
      let nombreEquipo = 'DESCONOCIDO'
      const jugadores: any[] = []
      let seccion: 'titulares' | 'suplentes' | null = null
      let ultimoTitularIdx: number | null = null

      for (const tr of tabla.querySelectorAll('tr')) {
        const th = tr.querySelector('th')
        if (th) {
          const texto = th.textContent!.trim()
          if (/CUERPO.?TÉCNICO/i.test(texto)) break
          else if (/TITULARES/i.test(texto)) { seccion = 'titulares'; nombreEquipo = texto.replace(/^TITULARES\s*/i, '').trim() }
          else if (/SUPLENTES/i.test(texto)) { seccion = 'suplentes' }
          continue
        }
        if (!seccion) continue
        const tdNombre = tr.querySelector('td#tdJugadorAlineado')
        if (!tdNombre) continue
        const { nombre, nombreCompleto } = nombresDesdeTd(tdNombre)
        if (!nombre) continue
        const imgSust = tr.querySelector('img#imgSustitucion') as HTMLImageElement | null
        if (seccion === 'titulares') {
          if (imgSust) {
            const m = /(\d+)/.exec(imgSust.getAttribute('title') ?? '')
            const minuto = m ? parseInt(m[1]) : null
            if (ultimoTitularIdx !== null) { jugadores[ultimoTitularIdx].minuto_salida = minuto; ultimoTitularIdx = null }
            jugadores.push({ nombre, nombre_completo: nombreCompleto, titular: false, convocado: true, minuto_entrada: minuto, minuto_salida: 90, goles_a_favor: null, goles_en_contra: null })
          } else {
            jugadores.push({ nombre, nombre_completo: nombreCompleto, titular: true, convocado: true, minuto_entrada: 0, minuto_salida: 90, goles_a_favor: null, goles_en_contra: null })
            ultimoTitularIdx = jugadores.length - 1
          }
        } else {
          if (!jugadores.some((j: any) => j.nombre_completo === nombreCompleto)) {
            jugadores.push({ nombre, nombre_completo: nombreCompleto, titular: false, convocado: true, minuto_entrada: null, minuto_salida: null, goles_a_favor: null, goles_en_contra: null })
          }
        }
      }
      return { nombreEquipo, jugadores }
    }

    function extraerGoles(div: Element) {
      const resultado: any[] = []
      for (const tabla of div.querySelectorAll('table.datosPartido')) {
        const th = tabla.querySelector('th')
        if (!th || !/GOLEADORES/i.test(th.textContent!)) continue
        const nombreEquipo = th.textContent!.trim().replace(/^GOLEADORES\s*/i, '').trim()
        const goles: any[] = []
        for (const tr of tabla.querySelectorAll('tr')) {
          const tdJ = tr.querySelector('td#tdJugadorAlineado')
          const tdR = tr.querySelector('td#tdResultadoParcial')
          if (!tdJ || !tdR) continue
          const { nombre, nombreCompleto } = nombresDesdeTd(tdJ)
          const parrafos = tdR.querySelectorAll('p')
          let minuto: number | null = null
          if (parrafos.length >= 2) { const m = /(\d+)/.exec(parrafos[1].textContent!.trim()); if (m) minuto = parseInt(m[1]) }
          const imgs = [...tdJ.querySelectorAll('img')] as HTMLImageElement[]
          const esPenalty = imgs.some(i => /penalti/i.test(i.getAttribute('title') ?? ''))
          const esPropia  = imgs.some(i => /propia meta/i.test(i.getAttribute('title') ?? ''))
          goles.push({ jugador: nombre, jugador_completo: nombreCompleto, minuto, es_penalty: esPenalty, es_propia_meta: esPropia })
        }
        resultado.push({ equipo: nombreEquipo, goles })
      }
      return resultado
    }

    function extraerTarjetas(div: Element, equipos: any[]) {
      const tablas = [...div.querySelectorAll('table.datosPartido')]
        .filter(t => t.id !== 'tableArbitroPartido')
        .filter(t => /TARJETAS/i.test(t.querySelector('th')?.textContent ?? ''))
      const indices = equipos.map(e => new Map(e.jugadores.map((j: any) => [j.nombre_completo, j])))
      tablas.forEach((tabla, i) => {
        const indice = indices[i] ?? new Map()
        for (const tr of tabla.querySelectorAll('tr')) {
          const tdJ = tr.querySelector('td#tdJugadorAlineado')
          const tdT = tr.querySelector('td#tdDatosTarjeta')
          if (!tdJ || !tdT) continue
          const { nombreCompleto } = nombresDesdeTd(tdJ)
          const imgs = [...tdT.querySelectorAll('img')] as HTMLImageElement[]
          const nAm = imgs.filter(i => (i.getAttribute('src') ?? '').toLowerCase().includes('yellow')).length
          const nRo = imgs.filter(i => (i.getAttribute('src') ?? '').toLowerCase().includes('red')).length
          const tarjetas = (nAm === 2 && nRo === 1) ? ['yellow', 'yellow'] : [...Array(nAm).fill('yellow'), ...Array(nRo).fill('red')]
          const jugador = indice.get(nombreCompleto) as any
          if (jugador && tarjetas.length > 0) jugador.tarjetas = [...(jugador.tarjetas ?? []), ...tarjetas]
        }
      })
    }

    function calcularGoles(equipos: any[], golesEquipos: any[]) {
      for (let i = 0; i < equipos.length; i++) {
        const gF = golesEquipos[i]?.goles ?? []
        const gC = golesEquipos[1 - i]?.goles ?? []
        const tF = gF.length, tC = gC.length
        const resultado = tF > tC ? 'VICTORIA' : tF < tC ? 'DERROTA' : 'EMPATE'
        for (const j of equipos[i].jugadores) {
          j.resultado = resultado
          if (j.minuto_entrada === null) { j.goles_a_favor = null; j.goles_en_contra = null; continue }
          const [en, sa] = [j.minuto_entrada, j.minuto_salida ?? 90]
          j.goles_a_favor  = gF.filter((g: any) => g.minuto !== null && en <= g.minuto && g.minuto <= sa).length
          j.goles_en_contra = gC.filter((g: any) => g.minuto !== null && en <= g.minuto && g.minuto <= sa).length
        }
      }
    }

    // ── Ejecutar ──────────────────────────────────────────────
    const divAlin = document.querySelector('#divAlineacionesPartido')!
    const equipos = [...divAlin.querySelectorAll('table[id^="tableAlineados"]')]
      .map(t => { const { nombreEquipo, jugadores } = extraerEquipo(t); return { equipo: nombreEquipo, jugadores } })

    const divGoles = document.querySelector('#divGoleadoresPartido')
    const golesEquipos = divGoles ? extraerGoles(divGoles) : []
    if (golesEquipos.length === equipos.length) calcularGoles(equipos, golesEquipos)

    const divTarj = document.querySelector('#divTarjetasPartido')
    if (divTarj) extraerTarjetas(divTarj, equipos)

    return { equipos, goles: golesEquipos.map((g: any) => ({ equipo: g.equipo, goles: g.goles })) }
  })

  return { url, equipos: data.equipos, goles: data.goles }
}

// ── Export principal ────────────────────────────────────────────

export async function extraerJornada(urlCalendario: string, numJornada: number): Promise<JornadaScraped | null> {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  })
  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    })
    const page = await context.newPage()
    await page.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }) })
    await page.goto(urlCalendario, { waitUntil: 'networkidle', timeout: 60_000 })
    await page.waitForSelector('#calendarContainer', { timeout: 20_000 }).catch(() => {})
    console.log(`[SCRAPER] Calendario cargado. Buscando jornada ${numJornada}...`)

    const pageTitle = await page.title()
    console.log(`[SCRAPER] Título página: "${pageTitle}"`)
    const calendarExists = await page.evaluate(() => !!document.querySelector('#calendarContainer'))
    console.log(`[SCRAPER] #calendarContainer existe: ${calendarExists}`)

    const { urlsJornada, nombreJornada } = await page.evaluate((numJornada: number) => {
      const urlsJornada: string[] = []
      let nombreJornada: string | null = null

      const flexDivs = document.querySelectorAll('#calendarContainer div[style*="display:flex"]')
      for (const flexDiv of flexDivs) {
        for (const hijo of flexDiv.children) {
          const th = hijo.querySelector('table tr:first-child th')
          if (!th) continue
          let textoTh = th.textContent!.trim().replace('schedule', '').replace('get_app', '').trim()
          const mNum = /JORNADA\s+(\d+)/i.exec(textoTh)
          if (!mNum || parseInt(mNum[1]) !== numJornada) continue
          nombreJornada = textoTh
          for (const fila of hijo.querySelectorAll('tr#filaPartido')) {
            const onclick = fila.getAttribute('onclick') ?? ''
            const m = /window\.location='([^']+)'/.exec(onclick)
            if (m) urlsJornada.push(`https://www.lapreferente.com/${m[1]}`)
          }
        }
      }
      return { urlsJornada, nombreJornada }
    }, numJornada)

    if (!urlsJornada.length || !nombreJornada) {
      console.log(`[SCRAPER] No se encontraron partidos para jornada ${numJornada}`)
      return null
    }

    console.log(`[SCRAPER] ${nombreJornada} — ${urlsJornada.length} partidos`)

    const partidos: PartidoScraped[] = []
    for (let idx = 0; idx < urlsJornada.length; idx++) {
      const res = await procesarPartido(page, urlsJornada[idx], idx + 1)
      if (res) partidos.push(res)
    }

    return { jornada: nombreJornada, partidos }
  } finally {
    await browser.close()
  }
}
