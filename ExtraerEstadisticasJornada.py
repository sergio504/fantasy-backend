import asyncio
import re
import json
from playwright.async_api import async_playwright
from bs4 import BeautifulSoup

URL = "https://www.lapreferente.com/C22283-19/tercera-federacion-grupo-4/calendario.html"


def extraer_jugadores_tabla(tabla, seccion):
    """
    Extrae jugadores de una tabla (titulares o suplentes).
    seccion: "titulares" | "suplentes"

    Devuelve lista de dicts:
      { nombre, titular, convocado, minutos, minuto_sustitucion }

    Lógica de minutos en titulares:
      - Si una fila tiene imgSustitucion en el primer td:
          ese jugador ENTRÓ (no es titular), jugó 90 - minuto
          el jugador ANTERIOR salió, jugó minuto minutos
      - Los titulares que no salen juegan 90
    Suplentes convocados que no entran: minutos=0
    """
    jugadores = []
    filas = tabla.find_all("tr")

    for i, fila in enumerate(filas):
        tds = fila.find_all("td")
        if not tds:
            continue

        # Primer td: puede tener imgSustitucion
        img_sust = tds[0].find("img", id="imgSustitucion")

        # Nombre: buscar el td con texto más largo que no sea solo números/iconos
        nombre = None
        for td in tds:
            texto = td.get_text(separator=" ", strip=True)
            # Ignorar tds con solo números o vacíos
            if texto and not re.fullmatch(r"[\d\s]+", texto):
                # Limpiar posibles iconos de Material Symbols
                texto = re.sub(r"\b(schedule|get_app|sports_soccer|square|circle)\b", "", texto).strip()
                if texto:
                    nombre = texto
                    break

        if not nombre:
            continue

        if seccion == "titulares":
            if img_sust:
                # Este jugador ENTRÓ como sustituto
                title = img_sust.get("title", "")
                m = re.search(r"(\d+)", title)
                minuto = int(m.group(1)) if m else None

                jugadores.append({
                    "nombre": nombre,
                    "convocado": True,
                    "titular": False,
                    "minutos": (90 - minuto) if minuto is not None else None,
                    "minuto_sustitucion": minuto,
                })

                # El jugador anterior (el que salió) ajustar sus minutos
                if jugadores and minuto is not None:
                    # Buscar hacia atrás el último jugador que aún tiene 90 min (el que salió)
                    for prev in reversed(jugadores[:-1]):
                        if prev["titular"] and prev["minutos"] == 90:
                            prev["minutos"] = minuto
                            prev["minuto_sustitucion"] = minuto
                            break
            else:
                jugadores.append({
                    "nombre": nombre,
                    "convocado": True,
                    "titular": True,
                    "minutos": 90,
                    "minuto_sustitucion": None,
                })
        else:  # suplentes
            jugadores.append({
                "nombre": nombre,
                "convocado": True,
                "titular": False,
                "minutos": 0,
                "minuto_sustitucion": None,
            })

    return jugadores


def extraer_alineaciones(html_div):
    soup = BeautifulSoup(html_div, "html.parser")

    # Buscar todas las tablas del div — normalmente hay 2, una por equipo
    tablas = soup.find_all("table")

    resultado = {}
    equipo_idx = 0
    equipo_nombres = ["local", "visitante"]

    i = 0
    while i < len(tablas) and equipo_idx < 2:
        tabla = tablas[i]
        texto_cabecera = tabla.get_text(" ", strip=True).lower()

        # Intentar detectar si es tabla de titulares o suplentes por th/caption/texto
        # Puede que estén agrupadas de otra forma — ajustar según HTML real
        # Por ahora asumimos estructura: tabla titulares seguida de tabla suplentes por equipo

        jugadores_equipo = []

        # Titulares
        jugadores_equipo += extraer_jugadores_tabla(tabla, "titulares")
        # Suplentes: tabla siguiente si existe
        if i + 1 < len(tablas):
            siguiente = tablas[i + 1]
            sups = extraer_jugadores_tabla(siguiente, "suplentes")
            if sups:
                jugadores_equipo += sups
                i += 1  # consumir también la de suplentes

        resultado[equipo_nombres[equipo_idx]] = jugadores_equipo
        equipo_idx += 1
        i += 1

    return resultado


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()

        print(f"Conectando a {URL} ...")
        await page.goto(URL, wait_until="domcontentloaded", timeout=60_000)

        # Obtener URL del primer partido de la primera jornada
        flex_divs = page.locator("#calendarContainer div[style*='display:flex']")
        count = await flex_divs.count()

        first_match_url = None
        first_jornada = None

        for i in range(count):
            hijos = flex_divs.nth(i).locator("> div")
            num_hijos = await hijos.count()
            for j in range(num_hijos):
                th = hijos.nth(j).locator("table tr:first-child th")
                if await th.count() == 0:
                    continue
                texto_th = (await th.first.inner_text()).strip()
                texto_th = texto_th.replace("schedule", "").replace("get_app", "").strip()

                filas = hijos.nth(j).locator("tr#filaPartido")
                if await filas.count() == 0:
                    continue

                onclick = await filas.nth(0).get_attribute("onclick")
                m = re.search(r"window\.location='([^']+)'", onclick or "")
                if m:
                    first_match_url = f"https://www.lapreferente.com/{m.group(1)}"
                    first_jornada = texto_th
                    break
            if first_match_url:
                break

        if not first_match_url:
            print("No se encontró ningún partido.")
            await browser.close()
            return

        print(f"Jornada: {first_jornada}")
        print(f"URL:     {first_match_url}\n")

        await page.goto(first_match_url, wait_until="domcontentloaded", timeout=60_000)

        # --- DEBUG: volcar HTML crudo de divAlineacionesPartido ---
        alin_loc = page.locator("#divAlineacionesPartido")
        if await alin_loc.count() == 0:
            print("No se encontró #divAlineacionesPartido")
            await browser.close()
            return

        html_div = await alin_loc.first.inner_html()

        with open("debug_alineaciones.html", "w", encoding="utf-8") as f:
            f.write(html_div)
        print("HTML de alineaciones guardado en debug_alineaciones.html\n")

        # --- Parsear alineaciones ---
        alineaciones = extraer_alineaciones(html_div)

        for equipo, jugadores in alineaciones.items():
            print(f"=== {equipo.upper()} ({len(jugadores)} jugadores) ===")
            for j in jugadores:
                estado = "TIT" if j["titular"] else ("ENT" if j["minutos"] else "SUP")
                print(f"  [{estado}] {j['nombre']:30s}  {j['minutos']} min")
            print()

        # Guardar en JSON
        salida = {
            "jornada": first_jornada,
            "url": first_match_url,
            "alineaciones": alineaciones,
        }
        with open("jornada_1_partido_1.json", "w", encoding="utf-8") as f:
            json.dump(salida, f, ensure_ascii=False, indent=2)

        print("Resultado guardado en jornada_1_partido_1.json")

        await browser.close()


asyncio.run(main())
