import { Router } from 'express'
import { authMiddleware } from '../middleware/auth.middleware'
import { getRankings } from '../controllers/explorar.controller'

const router = Router()
router.get('/rankings', authMiddleware, getRankings)
export default router
