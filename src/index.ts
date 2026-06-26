import { execSync } from 'child_process'
import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'

try {
  execSync('npx playwright install chromium --with-deps', { stdio: 'inherit' })
  console.log('[INIT] Playwright Chromium listo')
} catch (e) {
  console.error('[INIT] Error instalando Playwright:', e)
}
import authRoutes from './routes/auth.routes'
import ligaRoutes from './routes/league.routes'
import jugadorRoutes from './routes/player.routes'
import mercadoRoutes from './routes/market.routes'
import adminRoutes from './routes/admin.routes'
import jornadaRoutes from './routes/jornada.routes'
import clausulazoRoutes from './routes/clausulazo.routes'
import explorarRoutes from './routes/explorar.routes'
import { ponerJugadoresEnMercado, resolverOfertasCaducadas } from './jobs/mercadoAutomatico'
import { ejecutarJobsJornada } from './jobs/jornadaScheduler'

dotenv.config()

const app = express()
const PORT = process.env.PORT || 3001

app.use(cors())
app.use(express.json())

// Rutas
app.use('/api/auth', authRoutes)
app.use('/api/ligas', ligaRoutes)
app.use('/api/ligas/:ligaId/mercado', mercadoRoutes)
app.use('/api/ligas/:ligaId/plantillas', clausulazoRoutes)
app.use('/api/jugadores', jugadorRoutes)
app.use('/api/admin', adminRoutes)
app.use('/api/jornadas', jornadaRoutes)
app.use('/api/explorar', explorarRoutes)

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: '¡El servidor funciona!' })
})

// Calcula los ms hasta las 03:00 del día siguiente (hora local del servidor)
function calcularMsHastaLas3(): number {
  const ahora = new Date()
  const proximas3 = new Date(ahora)
  proximas3.setHours(3, 0, 0, 0)
  if (proximas3 <= ahora) proximas3.setDate(proximas3.getDate() + 1)
  return proximas3.getTime() - ahora.getTime()
}

app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`)

  // Mercado automático: se ejecuta cada 24h.
  // El job comprueba internamente si han pasado 3 días para cada liga.
  const ejecutarMercado = async () => {
    console.log('[JOB] Ejecutando mercado automático...')
    try {
      const resumen = await ponerJugadoresEnMercado()
      const total = resumen.reduce((s, r) => s + r.añadidos, 0)
      console.log(`[JOB] Mercado completado: ${total} jugadores añadidos`)
    } catch (e) {
      console.error('[JOB] Error en mercado automático:', e)
    }
  }

  const MS_24H = 24 * 60 * 60 * 1000
  setTimeout(() => {
    ejecutarMercado()
    setInterval(ejecutarMercado, MS_24H)
  }, calcularMsHastaLas3())

  console.log(`[JOB] Mercado automático programado. Primera ejecución en ${Math.round(calcularMsHastaLas3() / 1000 / 60)} min`)

  // Resolución de ofertas caducadas: cada hora
  const ejecutarResolucion = async () => {
    try {
      const { resueltas, canceladas } = await resolverOfertasCaducadas()
      if (resueltas + canceladas > 0) {
        console.log(`[JOB] Ofertas caducadas: ${resueltas} vendidas, ${canceladas} canceladas`)
      }
    } catch (e) {
      console.error('[JOB] Error resolviendo ofertas caducadas:', e)
    }
  }

  ejecutarResolucion() // ejecutar también al arrancar
  setInterval(ejecutarResolucion, 60 * 60 * 1000) // cada hora

  // Scheduler de jornadas: snapshot automático y cálculo de puntuaciones
  const MS_5MIN = 5 * 60 * 1000
  const ejecutarSchedulerJornadas = async () => {
    console.log(`[JOB] Scheduler jornadas tick — ${new Date().toISOString()}`)
    try {
      await ejecutarJobsJornada()
    } catch (e) {
      console.error('[JOB] Error inesperado en scheduler de jornadas:', e)
    }
  }
  ejecutarSchedulerJornadas() // ejecutar también al arrancar
  setInterval(ejecutarSchedulerJornadas, MS_5MIN)
  console.log('[JOB] Scheduler de jornadas activo (cada 5 min)')
})