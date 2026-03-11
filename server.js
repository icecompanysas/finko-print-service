const express = require('express')
const { exec }  = require('child_process')
const fs        = require('fs')
const path      = require('path')
const os        = require('os')
const app       = express()
const PORT      = 6788

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
    res.json({ ok: true, printers })
  } catch (e) {
    res.json({ ok: true, printers: [], error: String(e) })
  }
})

// ─── POST /print  ─────────────────────────────────────────────────────────────
// Body: { printerName: string, escpos: string (binary latin1) }
app.post('/print', async (req, res) => {
  const { printerName, escpos } = req.body
  if (!printerName || !escpos)
    return res.status(400).json({ error: 'Faltan printerName o escpos' })
  try {
    await printRaw(printerName, Buffer.from(escpos, 'binary'))
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: String(e) })
  }
})

// ─── Arranque ─────────────────────────────────────────────────────────────────
app.listen(PORT, '127.0.0.1', async () => {
  console.log('')
  console.log('  ✅  Finko Print Service corriendo en http://localhost:' + PORT)
  console.log('  ℹ️   Deja esta ventana abierta mientras usas Finko.')
  console.log('')
  const printers = await getPrinters()
  if (printers.length) {
    console.log('  Impresoras detectadas:')
    printers.forEach(p => console.log('    •', p))
  } else {
    console.log('  (No se detectaron impresoras aún)')
  }
  console.log('')
})
