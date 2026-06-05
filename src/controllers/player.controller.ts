import { Request, Response } from 'express'
import { prisma } from '../prismaClient'

export const getJugadores = async (req: Request, res: Response) => {
  try {
    const { posicion } = req.query

    const jugadores = await prisma.jugador.findMany({
      where: posicion ? { posicion: posicion as any } : undefined,
      orderBy: { valor: 'desc' }
    })

    res.json(jugadores)
  } catch {
    res.status(500).json({ error: 'Error al obtener jugadores' })
  }
}

export const getJugadorPorId = async (req: Request, res: Response) => {
  try {
    const jugador = await prisma.jugador.findUnique({
      where: { id: req.params.id as string }
    })

    if (!jugador) {
      res.status(404).json({ error: 'Jugador no encontrado' })
      return
    }

    res.json(jugador)
  } catch {
    res.status(500).json({ error: 'Error al obtener jugador' })
  }
}

export const getEstadisticasJugador = async (req: Request, res: Response) => {
  const id = req.params.id as string

  try {
    const jugadorEquipos = await prisma.jugadorEquipo.findMany({
      where: { jugadorId: id },
      select: { id: true },
    })

    const estadisticas = await prisma.estadisticaJornada.findMany({
      where: { jugadorEquipoId: { in: jugadorEquipos.map(je => je.id) } },
      include: {
        jornada: { select: { numJornada: true, division: true, fechaCierre: true } },
      },
      orderBy: { jornada: { numJornada: 'asc' } },
    })

    res.json(estadisticas)
  } catch {
    res.status(500).json({ error: 'Error al obtener estadísticas' })
  }
}
