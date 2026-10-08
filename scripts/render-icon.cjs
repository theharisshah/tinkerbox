/**
 * Renders build/icon.svg to build/icon.png (1024×1024) with Electron's own Chromium, so no extra
 * image tooling is needed. Run via `npm run icons` (which also builds build/icon.icns on macOS).
 */
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const root = join(__dirname, '..')
  const svg = readFileSync(join(root, 'build/icon.svg'), 'utf8')
  const html = `<!doctype html><html><body style="margin:0;background:transparent">${svg}</body></html>`
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    transparent: true,
    frame: false,
    webPreferences: { offscreen: true }
  })
  win.webContents.setFrameRate(1)
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  await new Promise((resolve) => setTimeout(resolve, 400))
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 })
  writeFileSync(join(root, 'build/icon.png'), image.resize({ width: 1024, height: 1024 }).toPNG())
  app.quit()
})
