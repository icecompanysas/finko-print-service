const { app, Tray, Menu, nativeImage } = require('electron')
const zlib = require('zlib')

// Una sola instancia
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0) }

let tray = null
let serverOk = false

// ─── Icono naranja 16×16 generado en código (sin archivos externos) ───────────
function makeIcon() {
  const W = 16, H = 16

  function crc32(buf) {
    const t = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
      t[n] = c
    }
    let c = 0xFFFFFFFF
    for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)
    return (c ^ 0xFFFFFFFF) >>> 0
  }

  function chunk(type, data) {
    const t = Buffer.from(type, 'ascii')
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])))
    return Buffer.concat([len, t, data, crc])
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4)
  ihdr[8] = 8; ihdr[9] = 2 // bitdepth=8, RGB

  const raw = Buffer.alloc(H * (1 + W * 3))
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 3)] = 0
    for (let x = 0; x < W; x++) {
      const p = y * (1 + W * 3) + 1 + x * 3
      raw[p] = 0xFF; raw[p + 1] = 0x66; raw[p + 2] = 0x00 // #FF6600
    }
  }

  return nativeImage.createFromBuffer(Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]))
}

// ─── Menú del tray ────────────────────────────────────────────────────────────
function buildMenu() {
  const autoStart = app.getLoginItemSettings().openAtLogin
  return Menu.buildFromTemplate([
    { label: 'Finko Print Service', enabled: false },
    { label: serverOk ? '● Activo  —  puerto 6788' : '○ Error al iniciar', enabled: false },
    { type: 'separator' },
    {
      label: 'Iniciar con Windows',
      type: 'checkbox',
      checked: autoStart,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked })
    },
    { type: 'separator' },
    { label: 'Salir', click: () => app.quit() }
  ])
}

// ─── Inicio ───────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  // Activar auto-inicio con Windows la primera vez
  if (!app.getLoginItemSettings().openAtLogin) {
    app.setLoginItemSettings({ openAtLogin: true })
  }

  // Arrancar el servidor HTTP
  try {
    require('./server')
    serverOk = true
  } catch (e) {
    serverOk = false
    console.error('Error al iniciar servidor:', e.message)
  }

  // Crear icono en bandeja del sistema
  tray = new Tray(makeIcon())
  tray.setToolTip(serverOk ? 'Finko Print  —  Activo' : 'Finko Print  —  Error')
  tray.setContextMenu(buildMenu())
})

// Mantener la app viva aunque no haya ventanas
app.on('window-all-closed', (e) => e.preventDefault())
