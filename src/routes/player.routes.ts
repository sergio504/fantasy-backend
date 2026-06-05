import { Router } from 'express'
import { getJugadores, getJugadorPorId, getEstadisticasJugador } from '../controllers/player.controller'
import { authMiddleware } from '../middleware/auth.middleware'

const router = Router()

router.get('/', authMiddleware, getJugadores)
router.get('/:id', authMiddleware, getJugadorPorId)
router.get('/:id/estadisticas', authMiddleware, getEstadisticasJugador)

export default router