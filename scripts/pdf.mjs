// Genera site/reporte-semanal.pdf a partir de site/reporte.html usando Chrome sin ventana.
// Uso: node scripts/pdf.mjs   (después de fetch-monday.mjs; CHROME_PATH indica dónde está Chrome si no se encuentra solo)
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = resolve(ROOT, process.env.SITE_DIR ?? 'site');
const OUT = resolve(SITE, 'reporte-semanal.pdf');

const executablePath = [
  process.env.CHROME_PATH,
  process.env.CHROME_BIN,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => p && existsSync(p));
if (!executablePath) {
  console.error('No se encontró Chrome. Indica su ruta en la variable CHROME_PATH.');
  process.exit(1);
}

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const data = JSON.parse(await readFile(resolve(SITE, 'data.json'), 'utf8'));
const browser = await puppeteer.launch({ executablePath, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.evaluateOnNewDocument(
    (d, site) => {
      window.__REPORT_DATA__ = d;
      window.__REPORT_SITE__ = site;
    },
    data,
    process.env.SITE_URL || null,
  );
  await page.goto(pathToFileURL(resolve(SITE, 'reporte.html')).href, { waitUntil: 'networkidle0', timeout: 60_000 });
  await page.waitForFunction('window.__reportReady === true', { timeout: 30_000 });
  if (pageErrors.length) throw new Error(`Error en la página del reporte: ${pageErrors.join('; ')}`);
  if (!(await page.$('.r-head'))) throw new Error(await page.$eval('#report', (el) => el.textContent.trim()));

  const heading = await page.$eval('h1', (el) => el.textContent.trim());
  await page.pdf({
    path: OUT,
    format: 'letter',
    printBackground: true,
    margin: { top: '12mm', right: '12mm', bottom: '16mm', left: '12mm' },
    displayHeaderFooter: true,
    headerTemplate: '<span></span>',
    footerTemplate: `<div style="width:100%;padding:0 12mm;display:flex;justify-content:space-between;font-family:Arial,Helvetica,sans-serif;font-size:8px;color:#6c6a64">
      <span>Reporte semanal PMO · ${escapeHtml(heading)}</span>
      <span>Página <span class="pageNumber"></span> de <span class="totalPages"></span></span>
    </div>`,
  });
  console.log(`PDF generado: ${OUT}`);
} finally {
  await browser.close();
}
