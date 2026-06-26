import { Request, Response } from 'express'
import { eq, and, desc, sum, inArray } from 'drizzle-orm'
import { db } from '../db'
import { jugador, jugadorEquipo, equipo, estadisticaJornada, miembroLiga, liga, usuario, aliasEquipo } from '../db/schema'
import type { Division } from '../db/schema'

const DIVISIONES_VALIDAS = ['RFEF2_GRUPO_II', 'RFEF3_GRUPO_IV', 'HONOR_BIZKAIA']

export const getRankings = async (req: Request, res: Response) => {
  const division = req.query.division as Division
  if (!division || !DIVISIONES_VALIDAS.includes(division)) {
    return res.status(400).json({ error: 'División no válida' })
  }

  try {
    const jugadoresPorPuntos = await db
      .select({
        jugadorId: jugador.id,
        nombre: jugador.nombre,
        posicion: jugador.posicion,
        valor: jugador.valor,
        equipoId: equipo.id,
        equipoNombre: equipo.nombre,
        totalPuntos: sum(estadisticaJornada.puntosCalculados),
      })
      .from(estadisticaJornada)
      .innerJoin(jugadorEquipo, eq(estadisticaJornada.jugadorEquipoId, jugadorEquipo.id))
      .innerJoin(jugador, eq(jugadorEquipo.jugadorId, jugador.id))
      .innerJoin(equipo, eq(jugadorEquipo.equipoId, equipo.id))
      .where(eq(equipo.division, division))
      .groupBy(jugador.id, jugador.nombre, jugador.posicion, jugador.valor, equipo.id, equipo.nombre)
      .orderBy(desc(sum(estadisticaJornada.puntosCalculados)))
      .limit(5)

    const jugadoresPorValor = await db
      .select({
        jugadorId: jugador.id,
        nombre: jugador.nombre,
        posicion: jugador.posicion,
        valor: jugador.valor,
        equipoId: equipo.id,
        equipoNombre: equipo.nombre,
      })
      .from(jugador)
      .innerJoin(jugadorEquipo, eq(jugador.id, jugadorEquipo.jugadorId))
      .innerJoin(equipo, eq(jugadorEquipo.equipoId, equipo.id))
      .where(and(eq(equipo.division, division), eq(jugadorEquipo.activo, true)))
      .orderBy(desc(jugador.valor))
      .limit(5)

    // Lookup de aliases para todos los equipos de los resultados
    const equipoIds = [...new Set([
      ...jugadoresPorPuntos.map(j => j.equipoId),
      ...jugadoresPorValor.map(j => j.equipoId),
    ])]

    const aliasMap = new Map<string, string>()
    if (equipoIds.length > 0) {
      const aliases = await db
        .select({ equipoId: aliasEquipo.equipoId, alias: aliasEquipo.alias })
        .from(aliasEquipo)
        .where(inArray(aliasEquipo.equipoId, equipoIds))
      for (const a of aliases) {
        if (!aliasMap.has(a.equipoId)) aliasMap.set(a.equipoId, a.alias)
      }
    }

    const resolverEquipo = (equipoId: string, nombre: string) => aliasMap.get(equipoId) ?? nombre

    const usuariosPorPuntos = await db
      .select({
        usuarioId: usuario.id,
        username: usuario.username,
        puntuacion: miembroLiga.puntuacion,
        miembroLigaId: miembroLiga.id,
        ligaId: liga.id,
        ligaNombre: liga.nombre,
      })
      .from(miembroLiga)
      .innerJoin(usuario, eq(miembroLiga.usuarioId, usuario.id))
      .innerJoin(liga, eq(miembroLiga.ligaId, liga.id))
      .where(and(eq(liga.division, division), eq(liga.publica, true)))
      .orderBy(desc(miembroLiga.puntuacion))
      .limit(5)

    res.json({
      jugadoresPorPuntos: jugadoresPorPuntos.map(j => ({
        ...j,
        equipoNombre: resolverEquipo(j.equipoId, j.equipoNombre),
      })),
      jugadoresPorValor: jugadoresPorValor.map(j => ({
        ...j,
        equipoNombre: resolverEquipo(j.equipoId, j.equipoNombre),
      })),
      usuariosPorPuntos,
    })
  } catch (e: any) {
    res.status(500).json({ error: e.message ?? 'Error al obtener rankings' })
  }
}
