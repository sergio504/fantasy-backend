import { Router } from 'express'
import { getJugadores, getJugadorPorId } from '../controllers/player.controller'
import { authMiddleware } from '../middleware/auth.middleware'

const router = Router()

router.get('/', authMiddleware, getJugadores)
router.get('/:id', authMiddleware, getJugadorPorId)

export default router