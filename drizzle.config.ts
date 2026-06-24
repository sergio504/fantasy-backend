import { defineConfig } from 'drizzle-kit'
import dotenv from 'dotenv'
import path from 'path'

if (!process.env.DATABASE_URL) {
  dotenv.config({ path: path.resolve(__dirname, '.env') })
}

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'mysql',
  dbCredentials: { url: process.env.DATABASE_URL! },
})
