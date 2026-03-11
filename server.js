const express = require('express')
const printer  = require('printer')
const app      = express()
const PORT     = 6788

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

// ─── GET /status  ─────────────────────────────────────────────────────────────
// Devuelve lista de impresoras instaladas en el sistema
app.get('/status', (_req, res) => {
  try {
    const printers = printer.getPrinters().map(p => p.name)
    res.json({ ok: true, printers })
  } catch (e) {
    res.json({ ok: true, printers: [], error: String(e) })
  }
})

// ─── POST /print  ─────────────────────────────────────────────────────────────
// Body: { printerName: string, escpos: string (binary latin1) }
app.post('/print', (req, res) => {
  const { printerName, escpos } = req.body
  if (!printerName || !escpos)
    return res.status(400).json({ error: 'Faltan printerName o escpos' })

  printer.printDirect({
    data:    Buffer.from(escpos, 'binary'),
    printer: printerName,
    type:    'RAW',
    success: () => res.json({ ok: true }),
    error:   (e) => res.status(500).json({ error: String(e) }),
  })
})

// ─── Arranque ─────────────────────────────────────────────────────────────────
app.listen(PORT, '127.0.0.1', () => {
  console.log('')
  console.log('  ✅  Finko Print Service corriendo en http://localhost:' + PORT)
  console.log('  ℹ️   Deja esta ventana abierta mientras usas Finko.')
  console.log('')
  try {
    const ps = printer.getPrinters().map(p => p.name)
    console.log('  Impresoras detectadas:')
    ps.forEach(p => console.log('    •', p))
  } catch {}
  console.log('')
})
