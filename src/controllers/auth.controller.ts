import { Request, Response } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { prisma } from '../prismaClient'

export const register = async (req: Request, res: Response) => {
  const { email, username, password } = req.body

  try {
    const hashedPassword = await bcrypt.hash(password, 10)
    const user = await prisma.user.create({
      data: { email, username, password: hashedPassword }
    })
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET!, { expiresIn: '7d' })
    res.status(201).json({ token, user: { id: user.id, email, username } })
  } catch {
    res.status(400).json({ error: 'El usuario o email ya existe' })
  }
}

export const login = async (req: Request, res: Response) => {
  const { email, password } = req.body

  try {
    const user = await prisma.user.findUnique({ where: { email } })
    if (!user) {
      res.status(404).json({ error: 'Usuario no encontrado' })
      return
    }

    const valid = await bcrypt.compare(password, user.password)
    if (!valid) {
      res.status(401).json({ error: 'Contraseña incorrecta' })
      return
    }

    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET!, { expiresIn: '7d' })
    res.json({ token, user: { id: user.id, email: user.email, username: user.username } })
  } catch {
    res.status(500).json({ error: 'Error del servidor' })
  }
}