import express from 'express'
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
} from '@whiskeysockets/baileys'
import pino from 'pino'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PORT || 3000
const SESS_DIR = path.join(__dirname, 'sessions')
const MAX_ACTIVE = 5
const TTL = 3 * 60 * 1000
const logger = pino({ level: 'silent' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Har start par purane temp sessions saaf
fs.rmSync(SESS_DIR, { recursive: true, force: true })
fs.mkdirSync(SESS_DIR, { recursive: true })

const sessions = new Map()

// Session band karo + disk se creds delete (server par kuch store nahi hota)
function finish(id, status, message) {
  const s = sessions.get(id)
  if (!s || s.done) return
  s.done = true
  s.status = status
  s.message = message
  clearTimeout(s.timer)
  try { s.sock?.end(undefined) } catch {}
  fs.rmSync(s.dir, { recursive: true, force: true })
  setTimeout(() => sessions.delete(id), 60_000)
}

async function createSession(number) {
  const id = crypto.randomBytes(8).toString('hex')
  const dir = path.join(SESS_DIR, id)
  const s = { status: 'pairing', message: '', done: false, dir, sock: null, sent: false, codeAsked: false }
  sessions.set(id, s)
  s.timer = setTimeout(() => finish(id, 'expired', 'Time khatam ho gaya. Dobara try karo.'), TTL)

  let resolveCode, rejectCode
  const codePromise = new Promise((res, rej) => { resolveCode = res; rejectCode = rej })

  let version
  try { ({ version } = await fetchLatestBaileysVersion()) } catch {}

  async function connect() {
    if (s.done) return
    const { state, saveCreds } = await useMultiFileAuthState(dir)
    if (s.done) return

    const sock = makeWASocket({ version, auth: state, logger, browser: Browsers.ubuntu('Chrome') })
    s.sock = sock
    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
      if (s.done) return

      if (connection === 'open' && !s.sent) {
        s.sent = true
        s.status = 'linked'
        await sleep(5000) // creds poori save hone do
        try {
          await sock.sendMessage(jidNormalizedUser(sock.user.id), {
            document: fs.readFileSync(path.join(dir, 'creds.json')),
            mimetype: 'application/json',
            fileName: 'creds.json',
            caption: 'Aapka creds.json. Ise kisi ke saath share mat karna!',
          })
          await sleep(3000)
          finish(id, 'sent', 'creds.json aapke WhatsApp par bhej diya gaya.')
        } catch (e) {
          finish(id, 'error', 'creds.json bhejne mein error: ' + (e?.message || e))
        }
      }

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode
        if (code === DisconnectReason.loggedOut) {
          finish(id, 'error', 'Logged out ho gaya. Dobara try karo.')
        } else if (!s.done) {
          await sleep(1500)
          connect().catch(() => {}) // pairing ke baad restart (515) yahin handle hota hai
        }
      }
    })

    if (!state.creds.registered && !s.codeAsked) {
      s.codeAsked = true
      await sleep(2000)
      try {
        resolveCode(await sock.requestPairingCode(number))
      } catch (e) {
        rejectCode(e)
        finish(id, 'error', 'Pairing code nahi mil paya.')
      }
    }
  }

  connect().catch((e) => { rejectCode(e); finish(id, 'error', 'Connection error.') })
  const code = await codePromise
  return { id, code: code?.match(/.{1,4}/g)?.join('-') || code }
}

const app = express()
app.set('trust proxy', 1)
app.use(express.json({ limit: '1kb' }))
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')))

const lastHit = new Map()
setInterval(() => lastHit.clear(), 10 * 60 * 1000)

app.post('/api/pair', async (req, res) => {
  const number = String(req.body?.number || '').replace(/\D/g, '')
  if (number.length < 8 || number.length > 15) {
    return res.status(400).json({ error: 'Number galat hai (country code ke saath, sirf digits).' })
  }
  const now = Date.now()
  if (now - (lastHit.get(req.ip) || 0) < 20_000) {
    return res.status(429).json({ error: 'Thoda ruko, 20 second baad dobara try karo.' })
  }
  if ([...sessions.values()].filter((x) => !x.done).length >= MAX_ACTIVE) {
    return res.status(503).json({ error: 'Server busy hai, thodi der baad try karo.' })
  }
  lastHit.set(req.ip, now)
  try {
    res.json(await createSession(number))
  } catch {
    res.status(500).json({ error: 'Pairing code nahi ban paya. Number check karke dobara try karo.' })
  }
})

app.get('/api/status/:id', (req, res) => {
  const s = sessions.get(req.params.id)
  if (!s) return res.status(404).json({ status: 'expired', message: 'Session nahi mila.' })
  res.json({ status: s.status, message: s.message })
})

app.listen(PORT, () => console.log('Running on http://localhost:' + PORT))
