import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { prisma } from '../prismaClient'

export interface AuthRequest extends Request {
  usuarioId?: string
}

export const authMiddleware = async (req: AuthRequest, res: Response, next: NextFunction) => {
  const token = req.headers.authorization?.split(' ')[1]

  if (!token) {
    res.status(401).json({ error: 'Token no proporcionado' })
    return
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as { usuarioId: string }

    const usuario = await prisma.usuario.findUnique({
      where: { id: decoded.usuarioId },
      select: { id: true, activo: true },
    })

    if (!usuario) {
      res.status(401).json({ error: 'Usuario no encontrado' })
      return
    }

    if (!usuario.activo) {
      res.status(403).json({ error: 'Tu cuenta está desactivada. Contacta con el administrador.' })
      return
    }

    req.usuarioId = decoded.usuarioId
    next()
  } catch {
    res.status(401).json({ error: 'Token inválido' })
  }
}