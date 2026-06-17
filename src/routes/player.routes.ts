import { Router } from 'express'
import { getJugadores, getJugadorPorId, getEstadisticasJugador, getHistorialValorJugador, getHistorialClausulaJugador } from '../controllers/player.controller'
import { authMiddleware } from '../middleware/auth.middleware'

const router = Router()

router.get('/', authMiddleware, getJugadores)
router.get('/:id', authMiddleware, getJugadorPorId)
router.get('/:id/estadisticas',    authMiddleware, getEstadisticasJugador)
router.get('/:id/historial-valor', authMiddleware, getHistorialValorJugador)
router.get('/:id/historial-clausula', authMiddleware, getHistorialClausulaJugador)

export default router