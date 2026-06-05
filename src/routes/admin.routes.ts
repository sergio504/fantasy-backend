import { Router } from 'express'
import { authMiddleware } from '../middleware/auth.middleware'
import { adminMiddleware } from '../middleware/admin.middleware'
import {
  getJugadoresAdmin, crearJugador, editarJugador,
  crearFichaje, cerrarFichaje,
  getEquipos, getHistorial,
  getEstadisticasJornada, editarEstadistica,
  getConfigPuntuacion, actualizarConfigPuntuacion,
  getUsuarios, toggleActivoUsuario,
  lanzarMercadoManual,
} from '../controllers/admin.controller'

const router = Router()

router.use(authMiddleware, adminMiddleware)

router.get('/jugadores',           getJugadoresAdmin)
router.post('/jugadores',          crearJugador)
router.patch('/jugadores/:id',     editarJugador)

router.post('/fichajes',           crearFichaje)
router.patch('/fichajes/:id/cerrar', cerrarFichaje)

router.get('/equipos',                       getEquipos)
router.get('/historial',                     getHistorial)
router.post('/mercado/lanzar',               lanzarMercadoManual)
router.get('/usuarios',                      getUsuarios)
router.patch('/usuarios/:id/toggle-activo',  toggleActivoUsuario)

router.get('/estadisticas/:jornadaId',       getEstadisticasJornada)
router.patch('/estadisticas/:id',            editarEstadistica)

router.get('/config-puntuacion',             getConfigPuntuacion)
router.patch('/config-puntuacion/:id',       actualizarConfigPuntuacion)

export default router
