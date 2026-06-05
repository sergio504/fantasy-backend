import { Response, NextFunction } from 'express'
import { AuthRequest } from './auth.middleware'
import { prisma } from '../prismaClient'

export const adminMiddleware = async (req: AuthRequest, res: Response, next: NextFunction) => {
  const usuario = await prisma.usuario.findUnique({
    where: { id: req.usuarioId! },
    select: { esAdmin: true },
  })

  if (!usuario?.esAdmin) {
    res.status(403).json({ error: 'Acceso restringido a administradores' })
    return
  }

  next()
}
