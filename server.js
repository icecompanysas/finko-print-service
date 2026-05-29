const express = require('express')
const { exec }  = require('child_process')
const fs        = require('fs')
const path      = require('path')
const os        = require('os')
const app       = express()
const PORT      = 6788

// ─── Config persistente ───────────────────────────────────────────────────────
const CONFIG_DIR  = path.join(os.homedir(), 'AppData', 'Roaming', 'FinkoPrint')
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')

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

// ─── GET /status  ─────────────────────────────────────────────────────────────
app.get('/status', async (_req, res) => {
  try {
    const printers = await getPrinters()
    const cfg = loadConfig()
    res.json({ ok: true, printers, defaultPrinter: cfg.defaultPrinter || null })
  } catch (e) {
    res.json({ ok: true, printers: [], defaultPrinter: null, error: String(e) })
  }
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
const server = app.listen(PORT, async () => {
  console.log('')
  console.log('  \u2705  Finko Print Service corriendo en http://localhost:' + PORT)
  console.log('')
  const printers = await getPrinters()
  const cfg = loadConfig()
  if (printers.length) {
    console.log('  Impresoras detectadas:')
    printers.forEach(p => console.log('    \u2022', p))
    // Autoguardar default si no hay una guardada
    if (!cfg.defaultPrinter) {
      const detected = detectThermalPrinter(printers)
      if (detected) {
        saveConfig({ ...cfg, defaultPrinter: detected })
        console.log('  \u2B50 Impresora default auto-configurada:', detected)
      }
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

process.on('uncaughtException', (err) => {
  console.error('\n  ERROR inesperado:', err.message)
  console.error('  Presiona cualquier tecla para cerrar...')
  setTimeout(() => process.exit(1), 15000)
})
