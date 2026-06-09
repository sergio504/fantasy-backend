import { randomUUID } from 'crypto'
import { Request, Response } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { eq } from 'drizzle-orm'
import { db } from '../db'
import { usuario } from '../db/schema'

export const register = async (req: Request, res: Response) => {
  const { email, username, password } = req.body

  try {
    const contrasena = await bcrypt.hash(password, 10)
    const id = randomUUID()
    const now = new Date()
    await db.insert(usuario).values({ id, email, username, contrasena, creadoEn: now })
    const token = jwt.sign({ usuarioId: id }, process.env.JWT_SECRET!, { expiresIn: '7d' })
    res.status(201).json({ token, usuario: { id, email, username, esAdmin: false, activo: true } })
  } catch {
    res.status(400).json({ error: 'El usuario o email ya existe' })
  }
}

export const login = async (req: Request, res: Response) => {
  const { email, password } = req.body

  try {
    const [user] = await db.select().from(usuario).where(eq(usuario.email, email)).limit(1)
    if (!user) {
      res.status(404).json({ error: 'Usuario no encontrado' })
      return
    }

    const valida = await bcrypt.compare(password, user.contrasena)
    if (!valida) {
      res.status(401).json({ error: 'Contraseña incorrecta' })
      return
    }

    if (!user.activo) {
      res.status(403).json({ error: 'Tu cuenta está desactivada. Contacta con el administrador.' })
      return
    }

    await db.update(usuario).set({ ultimoAcceso: new Date() }).where(eq(usuario.id, user.id))

    const token = jwt.sign({ usuarioId: user.id }, process.env.JWT_SECRET!, { expiresIn: '7d' })
    res.json({ token, usuario: { id: user.id, email: user.email, username: user.username, esAdmin: user.esAdmin, activo: user.activo } })
  } catch {
    res.status(500).json({ error: 'Error del servidor' })
  }
}
