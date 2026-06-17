import { Router } from 'express'
import { authMiddleware } from '../middleware/auth.middleware'
import { adminMiddleware } from '../middleware/admin.middleware'
import {
  getJugadoresAdmin, crearJugador, editarJugador,
  crearFichaje, cerrarFichaje,
  getEquipos, getHistorial, getHistorialConfig,
  getEstadisticasJornada, editarEstadistica,
  getConfigPuntuacion, actualizarConfigPuntuacion,
  getConfigEconomia, actualizarConfigEconomia,
  getConfigRevalorizacion, actualizarConfigRevalorizacion,
  getUsuarios, toggleActivoUsuario,
  lanzarMercadoManual,
  getDashboard,
  getAliasesEquipos, crearAliasEquipo, eliminarAliasEquipo,
  getAliasesJugadores, crearAliasJugador, eliminarAliasJugador,
} from '../controllers/admin.controller'

const router = Router()

router.use(authMiddleware, adminMiddleware)

router.get('/dashboard',               getDashboard)
router.get('/jugadores',           getJugadoresAdmin)
router.post('/jugadores',          crearJugador)
router.patch('/jugadores/:id',     editarJugador)

router.post('/fichajes',           crearFichaje)
router.patch('/fichajes/:id/cerrar', cerrarFichaje)

router.get('/equipos',                       getEquipos)
router.get('/historial',                     getHistorial)
router.get('/historial-config',              getHistorialConfig)
router.post('/mercado/lanzar',               lanzarMercadoManual)
router.get('/usuarios',                      getUsuarios)
router.patch('/usuarios/:id/toggle-activo',  toggleActivoUsuario)

router.get('/estadisticas/:jornadaId',       getEstadisticasJornada)
router.patch('/estadisticas/:id',            editarEstadistica)

router.get('/config-puntuacion',             getConfigPuntuacion)
router.patch('/config-puntuacion/:id',       actualizarConfigPuntuacion)

router.get('/config-economia',               getConfigEconomia)
router.patch('/config-economia/:clave',      actualizarConfigEconomia)

router.get('/config-revalorizacion',         getConfigRevalorizacion)
router.patch('/config-revalorizacion/:id',   actualizarConfigRevalorizacion)

router.get('/aliases/equipos',               getAliasesEquipos)
router.post('/aliases/equipos',              crearAliasEquipo)
router.delete('/aliases/equipos/:id',        eliminarAliasEquipo)

router.get('/aliases/jugadores',             getAliasesJugadores)
router.post('/aliases/jugadores',            crearAliasJugador)
router.delete('/aliases/jugadores/:id',      eliminarAliasJugador)

export default router
