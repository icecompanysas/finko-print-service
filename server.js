const express = require('express')
const { exec }  = require('child_process')
const fs        = require('fs')
const path      = require('path')
const os        = require('os')
const net       = require('net')
const app       = express()
const PORT      = 6788
const VERSION   = '1.7.0'

// ─── Config persistente ───────────────────────────────────────────────────────
const CONFIG_DIR  = path.join(os.homedir(), 'AppData', 'Roaming', 'FinkoPrint')
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')
const DEST_EXE    = path.join(CONFIG_DIR, 'FinkoImprimir.exe')
const STARTUP_DIR = path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
const STARTUP_VBS = path.join(STARTUP_DIR, 'FinkoPrintService.vbs')

// Se instala solo la primera vez que se ejecuta
function selfInstall() {
  try {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true })

    // Copiar el exe a AppData si no está ahí o si cambió
    const exePath = process.execPath
    const isAlreadyInstalled = exePath === DEST_EXE

    if (!isAlreadyInstalled) {
      fs.copyFileSync(exePath, DEST_EXE)
      console.log('  📦 Copiado a:', DEST_EXE)
    }

    // Crear/actualizar el VBScript de inicio silencioso
    const vbs = `Set oShell = CreateObject("WScript.Shell")\noShell.Run """${DEST_EXE}""", 0, False\n`
    if (!fs.existsSync(STARTUP_VBS) || fs.readFileSync(STARTUP_VBS, 'utf8') !== vbs) {
      fs.writeFileSync(STARTUP_VBS, vbs, 'utf8')
      console.log('  ✅ Autostart configurado — se iniciará con Windows')
    }
  } catch (e) {
    console.error('  ⚠️  No se pudo configurar autostart:', e.message)
  }
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
  } catch {}
  return {}
}

function saveConfig(data) {
  try {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true })
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), 'utf8')
  } catch {}
}

// Palabras clave que identifican impresoras térmicas POS
const THERMAL_KEYWORDS = ['pos', 'thermal', 'receipt', 'epson', 'star', 'bixolon', 'xprinter',
  'sewoo', 'rongta', 'citizen', '80mm', '58mm', 'ticket', 'recibo', 'termica', 'térmica']

function detectThermalPrinter(printers) {
  if (!printers.length) return null
  if (printers.length === 1) return printers[0]
  const lower = name => name.toLowerCase()
  const thermal = printers.find(p => THERMAL_KEYWORDS.some(k => lower(p).includes(k)))
  return thermal || printers[0]
}

// Cache de impresoras en memoria — se actualiza cada 30s para que /status responda instantáneo
let cachedPrinters = []
getPrinters().then(p => { cachedPrinters = p })
setInterval(() => getPrinters().then(p => { cachedPrinters = p }), 30000)

// ─── CORS + Private Network Access ───────────────────────────────────────────
// Permite que una página HTTPS (Vercel) haga fetch a http://localhost
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin',          '*')
  res.header('Access-Control-Allow-Methods',         'GET, POST, OPTIONS')
  res.header('Access-Control-Allow-Headers',         'Content-Type')
  res.header('Access-Control-Allow-Private-Network', 'true')
  if (req.method === 'OPTIONS') return res.status(200).end()
  next()
})

app.use(express.json({ limit: '2mb' }))

// ─── Balanza / Báscula RS-232 ─────────────────────────────────────────────────
// Usa System.IO.Ports de .NET via PowerShell — igual que la impresión,
// sin módulos nativos, compatible con pkg sin configuración extra.
const { spawn } = require('child_process')

function detectScaleParser(rawSample) {
  if (!rawSample) return null
  const sample = rawSample.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim()
  if (!sample) return null

  // Caso 1: número con punto decimal — "12.350", "+001.250", "ST,+001.250kg"
  const decMatch = sample.match(/([+-]?0*(\d+\.\d+))/)
  if (decMatch) {
    const cleanNum = parseFloat(decMatch[2])
    const after    = sample.slice(sample.indexOf(decMatch[1]) + decMatch[1].length).toLowerCase().trim()
    let unit = 'kg', factor = 1
    if (/^lb/.test(after))               { unit = 'lb'; factor = 0.453592 }
    else if (/^g(?:[^k]|$)/.test(after)) { unit = 'g';  factor = 0.001    }
    return { regex: '[+-]?0*(\\d+\\.\\d+)', unit, factor, detected_weight: cleanNum * factor, sample }
  }

  // Caso 2: entero largo (gramos sin decimal) — "000123"
  const intMatch = sample.match(/([+-]?0*(\d{3,}))/)
  if (intMatch) {
    const cleanNum = parseFloat(intMatch[2])
    const after    = sample.slice(sample.indexOf(intMatch[1]) + intMatch[1].length).toLowerCase().trim()
    let unit = 'g', factor = 0.001
    if (/^kg/.test(after)) { unit = 'kg'; factor = 1 }
    return { regex: '[+-]?0*(\\d+)', unit, factor, detected_weight: cleanNum * factor, sample }
  }
  return null
}

let scaleProc      = null  // proceso PowerShell leyendo el puerto
let scaleLastLines = []    // últimas tramas crudas recibidas
let scaleLastPeso  = null  // último peso en kg
let scaleLastTime  = null  // timestamp del último peso

function applyScaleParser(line, parser) {
  if (!parser?.regex) return null
  try {
    const m = line.match(new RegExp(parser.regex))
    if (!m) return null
    const v = parseFloat(m[1])
    return (isNaN(v) || v < 0) ? null : v * (parser.factor || 1)
  } catch { return null }
}

function connectScale(cfg) {
  if (scaleProc) { try { scaleProc.kill() } catch {} scaleProc = null }
  scaleLastPeso = null; scaleLastTime = null; scaleLastLines = []
  if (!cfg?.port) return

  // Leer el puerto serial con System.IO.Ports (.NET built-in en Windows)
  // — mismo enfoque que la impresión con PowerShell, sin módulos nativos
  const ps = `
try {
  $p = New-Object System.IO.Ports.SerialPort('${cfg.port}', ${cfg.baud || 9600}, 'None', 8, 1)
  $p.ReadTimeout = 3000
  $p.NewLine = "\`n"
  $p.Open()
  while ($true) {
    try { $line = $p.ReadLine(); if ($line) { Write-Host $line; [Console]::Out.Flush() } }
    catch [System.TimeoutException] {}
  }
} catch { Write-Error $_.Exception.Message }
finally { if ($p -and $p.IsOpen) { $p.Close() } }
`.trim()

  const proc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  proc.stdout.on('data', (data) => {
    for (const raw of data.toString().split('\n')) {
      const line = raw.replace(/\r/g, '').trim()
      if (!line) continue
      scaleLastLines.unshift(line)
      if (scaleLastLines.length > 10) scaleLastLines.pop()
      const peso = applyScaleParser(line, cfg.parser)
      if (peso !== null) { scaleLastPeso = peso; scaleLastTime = Date.now() }
    }
  })

  proc.stderr.on('data', (d) => console.error('  [BALANZA] Error:', d.toString().trim()))
  proc.on('exit', (code) => { console.log('  [BALANZA] Proceso terminado, código', code); scaleProc = null })

  scaleProc = proc
  console.log('  [BALANZA] Conectado a', cfg.port, '@', cfg.baud || 9600, 'bps')
}

// Init balanza: leer config guardada y conectar si hay puerto configurado
// NOTA: no se ejecuta al cargar el módulo — se llama desde main() solo
// después de confirmar que no hay otra instancia ya usando el puerto serial
// (dos instancias abriendo el mismo COM a la vez es lo que produce el error
// "Uno de los dispositivos conectados al sistema no funciona").
function initScale() {
  const cfg = loadConfig()
  if (cfg.scale?.port) {
    console.log('  [BALANZA] Conectando a', cfg.scale.port, '...')
    connectScale(cfg.scale)
  }
}

// Detecta si ya hay otra instancia de Finko Print Service escuchando en el
// puerto — para salir en silencio en vez de pelear por el puerto 6788 y el
// puerto serial de la balanza al mismo tiempo.
function otraInstanciaActiva() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port: PORT, host: '127.0.0.1' })
    const done = (activa) => { socket.destroy(); resolve(activa) }
    socket.setTimeout(800)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

// ── Endpoints de balanza ──────────────────────────────────────────────────────

// Puertos COM disponibles — usa WMIC (built-in Windows, sin módulos nativos)
function listComPorts() {
  return new Promise((resolve) => {
    exec(
      'powershell -NoProfile -Command "Get-WmiObject Win32_PnPEntity | Where-Object { $_.Name -match \'COM\\d+\' } | Select-Object Name, Description | ConvertTo-Json -Compress"',
      { timeout: 5000 },
      (err, stdout) => {
        if (err) { resolve([]); return }
        try {
          const raw = stdout.trim()
          if (!raw) { resolve([]); return }
          const parsed = JSON.parse(raw)
          const items = Array.isArray(parsed) ? parsed : [parsed]
          const ports = items.map(p => {
            const m = (p.Name || '').match(/\((COM\d+)\)/)
            return m ? { path: m[1], manufacturer: (p.Description || '').replace(/\s*\(COM\d+\)/, '').trim() } : null
          }).filter(Boolean)
          resolve(ports)
        } catch { resolve([]) }
      }
    )
  })
}

app.get('/balanza/ports', async (_req, res) => {
  res.json(await listComPorts())
})

// Estado de la balanza (lo usa el frontend para saber si está conectada)
app.get('/balanza/status', async (_req, res) => {
  const cfg = loadConfig()
  const ports = await listComPorts()
  res.json({
    available: true,
    connected: !!scaleProc,
    config: cfg.scale || null,
    ports,
    last_peso: scaleLastPeso,
    last_peso_age_ms: scaleLastTime ? Date.now() - scaleLastTime : null,
  })
})

// Guardar config y reconectar
app.post('/balanza/config', (req, res) => {
  const { port, baud, parser } = req.body
  if (!port) return res.status(400).json({ error: 'Falta port' })
  const cfg = loadConfig()
  cfg.scale = { port, baud: Number(baud) || 9600, parser: parser || null }
  saveConfig(cfg)
  connectScale(cfg.scale)
  res.json({ ok: true })
})

// Auto-detectar parser desde muestra pegada
app.post('/balanza/detect', (req, res) => {
  const { sample } = req.body
  if (!sample) return res.status(400).json({ error: 'Falta sample' })
  const result = detectScaleParser(sample)
  if (!result) return res.status(422).json({ error: 'No se detectó un valor numérico en la muestra' })
  res.json(result)
})

// Peso actual — lo llama el POS en tiempo real al pesar un producto
app.get('/balanza/peso', (_req, res) => {
  if (!scaleProc)            return res.status(503).json({ error: 'Sin conexión a balanza', connected: false })
  if (scaleLastPeso === null) return res.status(503).json({ error: 'Esperando primera lectura...', connected: true })
  const age = scaleLastTime ? Date.now() - scaleLastTime : 9999
  if (age > 5000)            return res.status(503).json({ error: 'Lectura desactualizada', connected: true })
  res.json({ peso: scaleLastPeso, unidad: 'kg', raw: scaleLastLines[0] || '', age_ms: age })
})

// Últimas líneas crudas (para diagnóstico y captura de muestra desde el frontend)
app.get('/balanza/capture', (_req, res) => {
  res.json({ lines: scaleLastLines, connected: !!scalePort })
})

// ─── Lista de impresoras via PowerShell ───────────────────────────────────────
function getPrinters() {
  return new Promise((resolve) => {
    exec(
      'powershell -NoProfile -Command "Get-Printer | Select-Object -ExpandProperty Name | ConvertTo-Json -Compress"',
      { timeout: 5000 },
      (err, stdout) => {
        if (err) { resolve([]); return }
        try {
          const raw = stdout.trim()
          if (!raw) { resolve([]); return }
          const parsed = JSON.parse(raw)
          resolve(Array.isArray(parsed) ? parsed : [parsed])
        } catch { resolve([]) }
      }
    )
  })
}

// ─── Impresión RAW via PowerShell + Windows Spooler API ──────────────────────
const PS_RAW_PRINT = `
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
public class DOCINFOA {
  [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
  [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
  [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
}
public class RawPrint {
  [DllImport("winspool.Drv",EntryPoint="OpenPrinterA",SetLastError=true,CharSet=CharSet.Ansi,ExactSpelling=true,CallingConvention=CallingConvention.StdCall)]
  public static extern bool OpenPrinter([MarshalAs(UnmanagedType.LPStr)] string n, out IntPtr h, IntPtr pd);
  [DllImport("winspool.Drv",EntryPoint="ClosePrinter",SetLastError=true,ExactSpelling=true,CallingConvention=CallingConvention.StdCall)]
  public static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.Drv",EntryPoint="StartDocPrinterA",SetLastError=true,CharSet=CharSet.Ansi,ExactSpelling=true,CallingConvention=CallingConvention.StdCall)]
  public static extern bool StartDocPrinter(IntPtr h, Int32 lvl, [In,MarshalAs(UnmanagedType.LPStruct)] DOCINFOA di);
  [DllImport("winspool.Drv",EntryPoint="EndDocPrinter",SetLastError=true,ExactSpelling=true,CallingConvention=CallingConvention.StdCall)]
  public static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.Drv",EntryPoint="StartPagePrinter",SetLastError=true,ExactSpelling=true,CallingConvention=CallingConvention.StdCall)]
  public static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.Drv",EntryPoint="EndPagePrinter",SetLastError=true,ExactSpelling=true,CallingConvention=CallingConvention.StdCall)]
  public static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.Drv",EntryPoint="WritePrinter",SetLastError=true,ExactSpelling=true,CallingConvention=CallingConvention.StdCall)]
  public static extern bool WritePrinter(IntPtr h, IntPtr pBytes, Int32 dwCount, out Int32 dwWritten);
  public static bool Send(string printer, byte[] data) {
    IntPtr hPrinter = IntPtr.Zero;
    var di = new DOCINFOA(); di.pDocName = "RAW"; di.pDataType = "RAW";
    if (!OpenPrinter(printer, out hPrinter, IntPtr.Zero)) return false;
    if (!StartDocPrinter(hPrinter, 1, di)) { ClosePrinter(hPrinter); return false; }
    StartPagePrinter(hPrinter);
    IntPtr ptr = Marshal.AllocCoTaskMem(data.Length);
    Marshal.Copy(data, 0, ptr, data.Length);
    int written = 0; bool ok = WritePrinter(hPrinter, ptr, data.Length, out written);
    Marshal.FreeCoTaskMem(ptr);
    EndPagePrinter(hPrinter); EndDocPrinter(hPrinter); ClosePrinter(hPrinter);
    return ok;
  }
}
"@
$bytes = [System.IO.File]::ReadAllBytes($args[0])
$ok = [RawPrint]::Send($args[1], $bytes)
exit $(if ($ok) { 0 } else { 1 })
`.trim()

function printRaw(printerName, buffer) {
  return new Promise((resolve, reject) => {
    const tmpBin = path.join(os.tmpdir(), `finko_${Date.now()}.bin`)
    const tmpPs  = path.join(os.tmpdir(), `finko_${Date.now()}.ps1`)
    fs.writeFileSync(tmpBin, buffer)
    fs.writeFileSync(tmpPs, PS_RAW_PRINT, 'utf8')
    const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -File "${tmpPs}" "${tmpBin}" "${printerName}"`
    exec(cmd, { timeout: 10000 }, (err, stdout, stderr) => {
      fs.unlink(tmpBin, () => {})
      fs.unlink(tmpPs,  () => {})
      if (err) reject(new Error(stderr || String(err)))
      else resolve()
    })
  })
}

// ─── GET / → Página de configuración de impresora ────────────────────────────
app.get('/', async (_req, res) => {
  const printers = await getPrinters()
  const cfg = loadConfig()
  const current = cfg.defaultPrinter || ''
  const rows = printers.map(p => `
    <tr class="${p === current ? 'active' : ''}" onclick="select('${p.replace(/'/g, "\\'")}')">
      <td class="dot">${p === current ? '●' : '○'}</td>
      <td>${p}</td>
      <td class="btn-cell"><button onclick="event.stopPropagation();select('${p.replace(/'/g, "\\'")}')">Usar esta</button></td>
    </tr>`).join('')
  res.send(`<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">
<title>Finko Print — Impresoras</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,sans-serif;background:#111;color:#eee;padding:24px;min-height:100vh}
  h1{font-size:1.2rem;font-weight:700;color:#ff6600;margin-bottom:4px}
  p.sub{font-size:.8rem;color:#777;margin-bottom:20px}
  table{width:100%;border-collapse:collapse;font-size:.9rem}
  tr{cursor:pointer;border-bottom:1px solid #222;transition:background .15s}
  tr:hover{background:#1a1a1a}
  tr.active{background:#1f1200}
  td{padding:12px 10px}
  td.dot{width:28px;font-size:1rem;color:#ff6600}
  td.btn-cell{width:110px;text-align:right}
  button{background:#ff6600;color:#fff;border:none;border-radius:8px;padding:6px 14px;font-size:.8rem;cursor:pointer}
  button:hover{background:#e55}
  .ok{margin-top:16px;padding:10px 14px;background:#0f2e0f;border:1px solid #2a5;border-radius:8px;color:#4c4;font-size:.85rem;display:none}
  .none{color:#555;padding:20px 0}
  .refresh{margin-top:18px;font-size:.8rem;color:#555;cursor:pointer;text-decoration:underline}
</style></head><body>
<h1>Finko Print Service v${VERSION}</h1>
<p class="sub">● Activo en puerto 6788${current ? ' &nbsp;·&nbsp; Impresora actual: <strong style="color:#ff6600">' + current + '</strong>' : ''}</p>
${printers.length
  ? `<table><tbody>${rows}</tbody></table>`
  : '<p class="none">No se detectaron impresoras instaladas.</p>'}
<div class="ok" id="ok">✔ Impresora guardada correctamente</div>
<p class="refresh" onclick="location.reload()">↻ Actualizar lista</p>
<script>
async function select(name) {
  await fetch('/default-printer', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({printer:name})})
  document.getElementById('ok').style.display='block'
  setTimeout(()=>location.reload(), 800)
}
</script></body></html>`)
})

// ─── GET /status  ─────────────────────────────────────────────────────────────
app.get('/status', (_req, res) => {
  const cfg = loadConfig()
  res.json({ ok: true, printers: cachedPrinters, defaultPrinter: cfg.defaultPrinter || null, version: VERSION })
})

// ─── GET /default-printer ─────────────────────────────────────────────────────
app.get('/default-printer', async (_req, res) => {
  try {
    const cfg = loadConfig()
    if (cfg.defaultPrinter) {
      return res.json({ ok: true, printer: cfg.defaultPrinter, source: 'saved' })
    }
    // Autodetectar
    const printers = await getPrinters()
    const detected = detectThermalPrinter(printers)
    if (detected) {
      saveConfig({ ...cfg, defaultPrinter: detected })
      console.log('  [AUTO] Impresora detectada y guardada:', detected)
      return res.json({ ok: true, printer: detected, source: 'auto' })
    }
    res.json({ ok: false, printer: null, source: 'none' })
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) })
  }
})

// ─── POST /default-printer ────────────────────────────────────────────────────
app.post('/default-printer', (req, res) => {
  const { printer } = req.body
  if (!printer) return res.status(400).json({ error: 'Falta printer' })
  const cfg = loadConfig()
  saveConfig({ ...cfg, defaultPrinter: printer })
  console.log('  [CONFIG] Impresora default guardada:', printer)
  res.json({ ok: true })
})

// ─── POST /print  ─────────────────────────────────────────────────────────────
// Body: { printerName?: string, escpos: string (binary latin1) }
// Si printerName no se pasa, usa la impresora default guardada
app.post('/print', async (req, res) => {
  let { printerName, escpos } = req.body
  if (!escpos) return res.status(400).json({ error: 'Falta escpos' })
  if (!printerName) {
    const cfg = loadConfig()
    printerName = cfg.defaultPrinter
    if (!printerName) {
      const printers = await getPrinters()
      printerName = detectThermalPrinter(printers)
      if (printerName) saveConfig({ ...cfg, defaultPrinter: printerName })
    }
  }
  if (!printerName)
    return res.status(400).json({ error: 'No hay impresora configurada' })
  console.log('  [PRINT] Impresora:', printerName, '| Bytes:', Buffer.from(escpos, 'binary').length)
  try {
    await printRaw(printerName, Buffer.from(escpos, 'binary'))
    console.log('  [PRINT] OK - trabajo enviado al spooler')
    res.json({ ok: true })
  } catch (e) {
    console.error('  [PRINT] ERROR:', String(e))
    res.status(500).json({ error: String(e) })
  }
})

// ─── POST /test-print ────────────────────────────────────────────────────────
app.post('/test-print', async (req, res) => {
  const { printerName } = req.body
  if (!printerName) return res.status(400).json({ error: 'Falta printerName' })
  const ESC = '\x1B', GS = '\x1D'
  const test = ESC + '@' +
    ESC + 'a\x01' + ESC + 'E\x01' + 'FINKO TEST\n' + ESC + 'E\x00' +
    ESC + 'a\x00' + '-------------------\n' +
    'Impresora: ' + printerName + '\n' +
    'Si ves esto funciona!\n' +
    '-------------------\n\n\n' +
    GS + 'V\x41\x03'
  console.log('  [TEST] Impresora:', printerName)
  try {
    await printRaw(printerName, Buffer.from(test, 'binary'))
    console.log('  [TEST] OK')
    res.json({ ok: true })
  } catch (e) {
    console.error('  [TEST] ERROR:', String(e))
    res.status(500).json({ error: String(e) })
  }
})

// ─── Arranque ─────────────────────────────────────────────────────────────────
// Antes de escuchar en 6788 o abrir el puerto serial de la balanza, se
// confirma que no haya ya otra instancia corriendo. Así una segunda ventana
// se cierra en silencio en vez de pelear por el COM de la balanza (dos
// SerialPort abriendo el mismo puerto a la vez producía el error
// "Uno de los dispositivos conectados al sistema no funciona").
async function main() {
  if (await otraInstanciaActiva()) {
    console.log('')
    console.log('  Finko Print Service ya esta corriendo en el puerto ' + PORT + '.')
    console.log('  Esta ventana se cerrara sola -- no es necesario abrir otra.')
    console.log('')
    setTimeout(() => process.exit(0), 3000)
    return
  }
  initScale()
  startServer()
}

function startServer() {
const server = app.listen(PORT, async () => {
  selfInstall()
  console.log('')
  console.log('  \u2705  Finko Print Service v' + VERSION + ' corriendo en http://localhost:' + PORT)
  console.log('  \uD83D\uDD27  Seleccionar impresora: http://localhost:' + PORT)
  console.log('')
  const printers = await getPrinters()
  const cfg = loadConfig()
  if (printers.length) {
    console.log('  Impresoras detectadas:')
    printers.forEach(p => console.log('    \u2022', p))
    if (!cfg.defaultPrinter) {
      // Sin impresora guardada \u2192 abrir p\u00E1gina de selecci\u00F3n en el navegador
      console.log('  \u26A0\uFE0F  Sin impresora configurada \u2014 abriendo selector...')
      exec('start http://localhost:' + PORT)
    } else {
      console.log('  \u2B50 Impresora default:', cfg.defaultPrinter)
    }
  } else {
    console.log('  (No se detectaron impresoras)')
  }
  console.log('')
})

server.on('error', (err) => {
  console.error('')
  if (err.code === 'EADDRINUSE') {
    console.error('  ERROR: El puerto ' + PORT + ' ya esta en uso.')
    console.error('  Cierra la otra ventana de Finko Print Service y vuelve a ejecutar.')
  } else {
    console.error('  ERROR al iniciar:', err.message)
  }
  console.error('')
  console.log('  Presiona cualquier tecla para cerrar...')
  process.stdin.setRawMode && process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.once('data', () => process.exit(1))
  setTimeout(() => process.exit(1), 15000)
})
}

main()

process.on('uncaughtException', (err) => {
  console.error('\n  ERROR inesperado:', err.message)
  console.error('  Presiona cualquier tecla para cerrar...')
  setTimeout(() => process.exit(1), 15000)
})
