import { Request, Response } from 'express'
import { prisma } from '../prismaClient'

export const getPlayers = async (req: Request, res: Response) => {
  try {
    const { position } = req.query

    const players = await prisma.player.findMany({
      where: position ? { position: position as any } : undefined,
      orderBy: { price: 'desc' }
    })

    res.json(players)
  } catch {
    res.status(500).json({ error: 'Error al obtener jugadores' })
  }
}

export const getPlayerById = async (req: Request, res: Response) => {
  try {
    const player = await prisma.player.findUnique({
      where: { id: req.params.id as string }
    })

    if (!player) {
      res.status(404).json({ error: 'Jugador no encontrado' })
      return
    }

    res.json(player)
  } catch {
    res.status(500).json({ error: 'Error al obtener jugador' })
  }
}