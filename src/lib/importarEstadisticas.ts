import { randomUUID } from 'crypto'
import { eq, and } from 'drizzle-orm'
import { db } from '../db'
import {
  jornada, jugador, jugadorEquipo, equipo, estadisticaJornada, estadisticaJornadaSinRegistrar,
  aliasEquipo, aliasJugador,
  Division, ResultadoPartido,
} from '../db/schema'
import type { JornadaScraped, GolScraped } from './scraper'

// ── Normalización ───────────────────────────────────────────────

function normalizar(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim()
}

function consonantes(s: string): string {
  return s.toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[AEIOU\s]/g, '').replace(/[^A-Z]/g, '')
}

function calcularResultado(favor: number, contra: number): ResultadoPartido {
  if (favor > contra) return 'VICTORIA'
  if (favor < contra) return 'DERROTA'
  return 'EMPATE'
}

function minutosJugados(minEntrada: number | null, minSalida: number | null): number {
  if (minEntrada === null) return 0
  return (minSalida ?? 90) - minEntrada
}

// ── Importación ─────────────────────────────────────────────────

export async function importarEstadisticas(
  data: JornadaScraped,
  division: Division,
  jornadaId: string,
): Promise<{ ok: number; noEncontrado: number }> {

  // Cargar aliases
  const aeRows = await db.select({ alias: aliasEquipo.alias, nombre: equipo.nombre })
    .from(aliasEquipo).innerJoin(equipo, eq(aliasEquipo.equipoId, equipo.id))
  const mapaAliasEquipos = new Map(aeRows.map(r => [normalizar(r.alias), normalizar(r.nombre)]))

  const ajRows = await db.select({ alias: aliasJugador.alias, nombreCompleto: jugador.nombreCompleto })
    .from(aliasJugador).innerJoin(jugador, eq(aliasJugador.jugadorId, jugador.id))
  const mapaAliasJugadores = new Map(ajRows.map(r => [normalizar(r.alias), normalizar(r.nombreCompleto)]))

  const resolverEquipo  = (n: string) => mapaAliasEquipos.get(normalizar(n))  ?? normalizar(n)
  const resolverJugador = (n: string) => mapaAliasJugadores.get(normalizar(n)) ?? normalizar(n)

  // Todos los equipos de la división (se carga una vez)
  const todosEquipos = await db.select().from(equipo).where(eq(equipo.division, division))

  let totalOk = 0
  let totalNoEncontrado = 0

  for (const [pIdx, partido] of data.partidos.entries()) {
    console.log(`[IMPORT] Partido ${pIdx + 1}: ${partido.url}`)

    for (const [eIdx, equipoJSON] of partido.equipos.entries()) {
      const golesEquipo: GolScraped[] = partido.goles[eIdx]?.goles ?? []
      const golesRival:  GolScraped[] = partido.goles[1 - eIdx]?.goles ?? []
      const totalFavor  = golesEquipo.length
      const totalContra = golesRival.length

      // Buscar equipo en BD
      const nombreNorm = resolverEquipo(equipoJSON.equipo)
      const equipoBD =
        todosEquipos.find(e => normalizar(e.nombre) === nombreNorm) ??
        todosEquipos.find(e => { const n = normalizar(e.nombre); return n.includes(nombreNorm) || nombreNorm.includes(n) }) ??
        todosEquipos.find(e => {
          const palabrasBD = new Set(normalizar(e.nombre).split(' ').filter(p => p.length > 2))
          return nombreNorm.split(' ').filter(p => p.length > 2).filter(p => palabrasBD.has(p)).length >= 2
        })

      if (!equipoBD) {
        console.warn(`[IMPORT] Equipo no encontrado: "${equipoJSON.equipo}"`)
        continue
      }

      // Jugadores activos del equipo
      const jeRows = await db.select({ je: jugadorEquipo, jug: jugador })
        .from(jugadorEquipo).innerJoin(jugador, eq(jugadorEquipo.jugadorId, jugador.id))
        .where(and(eq(jugadorEquipo.equipoId, equipoBD.id), eq(jugadorEquipo.activo, true)))

      for (const jugadorJSON of equipoJSON.jugadores) {
        const nombreBuscado      = resolverJugador(jugadorJSON.nombre_completo)
        const consonantesBuscado = consonantes(nombreBuscado)

        const coincidencia =
          jeRows.find(r => normalizar(r.jug.nombreCompleto) === nombreBuscado) ??
          jeRows.find(r => consonantes(normalizar(r.jug.nombreCompleto)) === consonantesBuscado)

        const tarjetas      = jugadorJSON.tarjetas ?? []
        const tarjetasAmar  = tarjetas.filter(t => t === 'yellow').length
        const tarjetaRoja   = tarjetas.includes('red')
        const minutos       = minutosJugados(jugadorJSON.minuto_entrada, jugadorJSON.minuto_salida)
        const resultado     = calcularResultado(totalFavor, totalContra)
        const diferencia    = totalFavor - totalContra

        if (!coincidencia) {
          const golesAnotados = golesEquipo.filter(g => normalizar(g.jugador_completo) === nombreBuscado && !g.es_propia_meta)
          const golesPropia   = golesRival.filter(g => normalizar(g.jugador_completo) === nombreBuscado && g.es_propia_meta).length
          try {
            await db.insert(estadisticaJornadaSinRegistrar).values({
              id: randomUUID(), jornadaId, equipoId: equipoBD.id,
              nombreEquipoScraper: equipoJSON.equipo, nombreJugadorScraper: jugadorJSON.nombre,
              nombreCompletoScraper: jugadorJSON.nombre_completo,
              convocado: jugadorJSON.convocado, titular: jugadorJSON.titular, minutosJugados: minutos,
              goles: golesAnotados.length, golesDePenalti: golesAnotados.filter(g => g.es_penalty).length,
              tarjetasAmarillas: tarjetasAmar, tarjetaRoja, resultado,
              golesEncajados: jugadorJSON.goles_en_contra ?? 0,
              golesAFavor: jugadorJSON.goles_a_favor ?? 0,
              golEnPropia: golesPropia, diferenciaGoles: diferencia,
              creadoEn: new Date(),
            })
          } catch { /* ignora duplicados */ }
          console.warn(`[IMPORT]   No encontrado: "${jugadorJSON.nombre_completo}"`)
          totalNoEncontrado++
          continue
        }

        const { je } = coincidencia
        const golesAnotados = golesEquipo.filter(g => normalizar(g.jugador_completo) === nombreBuscado && !g.es_propia_meta)
        const golesPropia   = golesRival.filter(g => normalizar(g.jugador_completo) === nombreBuscado && g.es_propia_meta).length

        try {
          await db.insert(estadisticaJornada).values({
            id: randomUUID(), jornadaId, jugadorEquipoId: je.id,
            convocado: jugadorJSON.convocado, titular: jugadorJSON.titular, minutosJugados: minutos,
            goles: golesAnotados.length, golesDePenalti: golesAnotados.filter(g => g.es_penalty).length,
            golEnPropia: golesPropia, tarjetasAmarillas: tarjetasAmar, tarjetaRoja,
            resultado, golesEncajados: jugadorJSON.goles_en_contra ?? 0,
            golesAFavor: jugadorJSON.goles_a_favor ?? 0, diferenciaGoles: diferencia,
            puntosCalculados: 0,
          })
          totalOk++
        } catch (e: any) {
          if (e?.code !== 'ER_DUP_ENTRY') throw e
        }
      }
    }
  }

  await db.update(jornada).set({ statsImportadas: true }).where(eq(jornada.id, jornadaId))
  console.log(`[IMPORT] Fin: ${totalOk} OK, ${totalNoEncontrado} no encontrados`)
  return { ok: totalOk, noEncontrado: totalNoEncontrado }
}
