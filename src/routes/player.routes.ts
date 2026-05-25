import { Router } from 'express'
import { getPlayers, getPlayerById } from '../controllers/player.controller'
import { authMiddleware } from '../middleware/auth.middleware'

const router = Router()

router.get('/', authMiddleware, getPlayers)
router.get('/:id', authMiddleware, getPlayerById)

export default router