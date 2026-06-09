import { Response, NextFunction } from 'express'
import { AuthRequest } from './auth.middleware'
import { db } from '../db'
import { usuario } from '../db/schema'
import { eq } from 'drizzle-orm'

export const adminMiddleware = async (req: AuthRequest, res: Response, next: NextFunction) => {
  const [user] = await db.select({ esAdmin: usuario.esAdmin })
    .from(usuario)
    .where(eq(usuario.id, req.usuarioId!))
    .limit(1)

  if (!user?.esAdmin) {
    res.status(403).json({ error: 'Acceso restringido a administradores' })
    return
  }

  next()
}
