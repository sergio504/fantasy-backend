import { Router } from 'express'
import { authMiddleware } from '../middleware/auth.middleware'
import { adminMiddleware } from '../middleware/admin.middleware'
import {
  crearJornada, getJornadas,
  generarSnapshot, simularJornada, calcularPuntuaciones,
  getPuntuacionesJornada, getEstadisticasJornada,
} from '../controllers/jornada.controller'

const router = Router()

// Rutas de admin
router.post('/',                               authMiddleware, adminMiddleware, crearJornada)
router.get('/',                                authMiddleware, adminMiddleware, getJornadas)
router.post('/:jornadaId/snapshot',            authMiddleware, adminMiddleware, generarSnapshot)
router.post('/:jornadaId/simular',             authMiddleware, adminMiddleware, simularJornada)
router.post('/:jornadaId/calcular',            authMiddleware, adminMiddleware, calcularPuntuaciones)

// Rutas de usuario (dentro de una liga)
router.get('/liga/:ligaId/:jornadaId',         authMiddleware, getPuntuacionesJornada)
router.get('/liga/:ligaId/:jornadaId/mis-stats', authMiddleware, getEstadisticasJornada)

export default router
