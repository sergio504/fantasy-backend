import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import authRoutes from './routes/auth.routes'
import ligaRoutes from './routes/league.routes'
import jugadorRoutes from './routes/player.routes'
import mercadoRoutes from './routes/market.routes'

dotenv.config()

const app = express()
const PORT = process.env.PORT || 3001

app.use(cors())
app.use(express.json())

// Rutas
app.use('/api/auth', authRoutes)
app.use('/api/ligas', ligaRoutes)
app.use('/api/ligas/:ligaId/mercado', mercadoRoutes)
app.use('/api/jugadores', jugadorRoutes)


// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: '¡El servidor funciona!' })
})

app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`)
})