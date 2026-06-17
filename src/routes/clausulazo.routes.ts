import { Router } from 'express'
import { getPlantillasLiga, ejecutarClausulazo, invertirEnClausula } from '../controllers/clausulazo.controller'
import { authMiddleware } from '../middleware/auth.middleware'

const router = Router({ mergeParams: true })

router.get('/', authMiddleware, getPlantillasLiga)
router.post('/:jugadorId/clausulazo', authMiddleware, ejecutarClausulazo)
router.post('/:jugadorId/clausula-inversion', authMiddleware, invertirEnClausula)

export default router
