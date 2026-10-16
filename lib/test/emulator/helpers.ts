import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app'
import { connectDatabaseEmulator, getDatabase, goOffline, type Database } from 'firebase/database'

export const NAMESPACE = 'firetap-test'

function emulatorHost(): string {
  const host = process.env.FIREBASE_DATABASE_EMULATOR_HOST
  if (!host) {
    throw new Error(
      'FIREBASE_DATABASE_EMULATOR_HOST is not set. Run emulator tests with `npm run test:emulator` from the repo root.'
    )
  }
  return host
}

const OPEN_RULES = { rules: { '.read': true, '.write': true } }

export async function setRules(rules: object = OPEN_RULES): Promise<void> {
  const res = await fetch(`http://${emulatorHost()}/.settings/rules.json?ns=${NAMESPACE}`, {
    method: 'PUT',
    headers: { Authorization: 'Bearer owner' },
    body: JSON.stringify(rules),
  })
  if (!res.ok) throw new Error(`Failed to set rules: ${res.status} ${await res.text()}`)
}

export async function readRaw(path: string): Promise<unknown> {
  const res = await fetch(`http://${emulatorHost()}/${path.replace(/^\//, '')}.json?ns=${NAMESPACE}`, {
    headers: { Authorization: 'Bearer owner' },
  })
  return res.json()
}

let appCounter = 0
const apps: FirebaseApp[] = []

export function createClient(): Database {
  const [host, port] = emulatorHost().split(':')
  const app = initializeApp(
    { projectId: 'demo-firetap', databaseURL: `http://${host}:${port}?ns=${NAMESPACE}` },
    `firetap-test-${process.pid}-${appCounter++}`
  )
  apps.push(app)
  const db = getDatabase(app)
  connectDatabaseEmulator(db, host, Number(port))
  return db
}

export async function closeClients(): Promise<void> {
  for (const app of apps.splice(0)) {
    goOffline(getDatabase(app))
    await deleteApp(app)
  }
}

export function uniqueBasePath(label: string): string {
  return `/t-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}
