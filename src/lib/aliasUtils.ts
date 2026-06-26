import { inArray } from 'drizzle-orm'
import { db } from '../db'
import { aliasEquipo } from '../db/schema'

export async function cargarAliasEquipos(equipoIds: string[]): Promise<Map<string, string>> {
  const aliasMap = new Map<string, string>()
  if (equipoIds.length === 0) return aliasMap
  const rows = await db
    .select({ equipoId: aliasEquipo.equipoId, alias: aliasEquipo.alias })
    .from(aliasEquipo)
    .where(inArray(aliasEquipo.equipoId, equipoIds))
  for (const r of rows) {
    if (!aliasMap.has(r.equipoId)) aliasMap.set(r.equipoId, r.alias)
  }
  return aliasMap
}
