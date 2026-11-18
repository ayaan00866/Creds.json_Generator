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
