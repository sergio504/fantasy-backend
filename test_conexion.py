import asyncio
import re
from playwright.async_api import async_playwright

URL = "https://www.lapreferente.com/C22283-19/tercera-federacion-grupo-4/calendario.html"

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()

        print(f"Conectando a {URL} ...")
        response = await page.goto(URL, wait_until="networkidle", timeout=30_000)

        print(f"Status HTTP: {response.status}")
        print(f"Título: {await page.title()}")
        print(f"URL final: {page.url}")

        # Por cada div flex, entrar en sus dos hijos y leer el th del primer tr
        flex_divs = page.locator("#calendarContainer div[style*='display:flex']")
        count = await flex_divs.count()

        jornadas = []
        for i in range(count):
            hijos = flex_divs.nth(i).locator("> div")
            num_hijos = await hijos.count()
            for j in range(num_hijos):
                th = hijos.nth(j).locator("table tr:first-child th")
                if await th.count() > 0:
                    texto = (await th.first.inner_text()).strip()
                    # Limpiar iconos de material symbols
                    texto = texto.replace("schedule", "").replace("get_app", "").strip()
                    jornadas.append(texto)

        # Ordenar por número de jornada
        def num_jornada(t):
            m = re.search(r"JORNADA\s+(\d+)", t)
            return int(m.group(1)) if m else 0

        jornadas.sort(key=num_jornada)
        print(f"\n{len(jornadas)} jornadas encontradas:\n")
        for j in jornadas:
            print(f"  {j}")

        # Por cada jornada, coger el primer partido y explorar sus divs
        print(f"\n--- Primer partido de cada jornada ---\n")
        primeros_partidos = []  # (texto_jornada, url)

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
                    primeros_partidos.append((texto_th, f"https://www.lapreferente.com/{m.group(1)}"))

        # Ordenar por número de jornada
        primeros_partidos.sort(key=lambda x: num_jornada(x[0]))

        for texto_jornada, url in primeros_partidos:
            print(f"{'='*60}")
            print(f"{texto_jornada}")
            print(f"URL: {url}")

            await page.goto(url, wait_until="networkidle", timeout=30_000)

            for div_id in ["divAlineacionesPartido", "divGoleadoresPartido", "divTarjetasPartido"]:
                loc = page.locator(f"#{div_id}")
                if await loc.count() == 0:
                    print(f"\n  [{div_id}]: NO ENCONTRADO")
                    continue
                texto = (await loc.first.inner_text()).strip()
                texto = re.sub(r'\s+', ' ', texto)
                print(f"\n  [{div_id}] (primeros 300 chars):")
                print(f"  {texto[:300]}")
            print()

        await browser.close()

asyncio.run(main())
