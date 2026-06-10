import { Router } from 'express'
import {
  getOfertasLiga,
  crearOferta,
  pujar,
  cerrarOferta,
  cancelarOferta,
  retirarPuja,
  ventaRapida,
  getTransferencias,
} from '../controllers/market.controller'
import { authMiddleware } from '../middleware/auth.middleware'

// mergeParams permite acceder a :ligaId definido en el router padre
const router = Router({ mergeParams: true })

router.get('/', authMiddleware, getOfertasLiga)
router.post('/', authMiddleware, crearOferta)
router.post('/:ofertaId/pujar', authMiddleware, pujar)
router.post('/:ofertaId/cerrar', authMiddleware, cerrarOferta)
router.delete('/:ofertaId', authMiddleware, cancelarOferta)
router.delete('/:ofertaId/pujar', authMiddleware, retirarPuja)
router.post('/venta-rapida', authMiddleware, ventaRapida)

export default router
