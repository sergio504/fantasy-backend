import { Router } from 'express'
import {
  crearLiga,
  unirseALiga,
  unirseConCodigo,
  getLigasPublicas,
  getMisLigas,
  getLiga,
  getMiEquipo,
  getJugadoresDisponibles,
  getAlineacion,
  guardarAlineacion,
} from '../controllers/league.controller'
import { getTransferencias } from '../controllers/market.controller'
import { authMiddleware } from '../middleware/auth.middleware'

const router = Router()

router.get('/', getLigasPublicas)
router.get('/mis-ligas', authMiddleware, getMisLigas)
router.get('/:ligaId', authMiddleware, getLiga)
router.post('/', authMiddleware, crearLiga)
router.post('/unirse/:ligaId', authMiddleware, unirseALiga)
router.post('/unirse-con-codigo', authMiddleware, unirseConCodigo)
router.get('/:ligaId/transferencias', authMiddleware, getTransferencias)
router.get('/:ligaId/mi-equipo', authMiddleware, getMiEquipo)
router.get('/:ligaId/jugadores-disponibles', authMiddleware, getJugadoresDisponibles)
router.get('/:ligaId/mi-alineacion', authMiddleware, getAlineacion)
router.post('/:ligaId/mi-alineacion', authMiddleware, guardarAlineacion)

export default router
