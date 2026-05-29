import { Request, Response } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { prisma } from '../prismaClient'

export const register = async (req: Request, res: Response) => {
  const { email, username, password } = req.body

  try {
    const contrasena = await bcrypt.hash(password, 10)
    const usuario = await prisma.usuario.create({
      data: { email, username, contrasena }
    })
    const token = jwt.sign({ usuarioId: usuario.id }, process.env.JWT_SECRET!, { expiresIn: '7d' })
    res.status(201).json({ token, usuario: { id: usuario.id, email, username } })
  } catch {
    res.status(400).json({ error: 'El usuario o email ya existe' })
  }
}

export const login = async (req: Request, res: Response) => {
  const { email, password } = req.body

  try {
    const usuario = await prisma.usuario.findUnique({ where: { email } })
    if (!usuario) {
      res.status(404).json({ error: 'Usuario no encontrado' })
      return
    }

    const valida = await bcrypt.compare(password, usuario.contrasena)
    if (!valida) {
      res.status(401).json({ error: 'Contraseña incorrecta' })
      return
    }

    const token = jwt.sign({ usuarioId: usuario.id }, process.env.JWT_SECRET!, { expiresIn: '7d' })
    res.json({ token, usuario: { id: usuario.id, email: usuario.email, username: usuario.username } })
  } catch {
    res.status(500).json({ error: 'Error del servidor' })
  }
}
