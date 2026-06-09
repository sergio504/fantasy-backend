import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { usuario } from '../db/schema'
import { eq } from 'drizzle-orm'

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

    const [user] = await db.select({ id: usuario.id, activo: usuario.activo })
      .from(usuario)
      .where(eq(usuario.id, decoded.usuarioId))
      .limit(1)

    if (!user) {
      res.status(401).json({ error: 'Usuario no encontrado' })
      return
    }

    if (!user.activo) {
      res.status(403).json({ error: 'Tu cuenta está desactivada. Contacta con el administrador.' })
      return
    }

    req.usuarioId = decoded.usuarioId
    next()
  } catch {
    res.status(401).json({ error: 'Token inválido' })
  }
}
