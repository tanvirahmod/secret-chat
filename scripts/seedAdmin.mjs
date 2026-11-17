import 'dotenv/config'
import admin from 'firebase-admin'
import fs from 'node:fs'

// Option 1: FIREBASE_SERVICE_ACCOUNT_PATH pointing to a service account JSON file
// Option 2: GOOGLE_APPLICATION_CREDENTIALS set (firebase-admin default)
// This script creates/ensures the initial Controller (admin) user in Auth + Firestore.
const saPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || process.env.GOOGLE_APPLICATION_CREDENTIALS
if (!admin.apps.length) {
  if (saPath && fs.existsSync(saPath)) {
    const serviceAccount = JSON.parse(fs.readFileSync(saPath, 'utf8'))
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) })
  } else {
    // Falls back to application default credentials if available
    admin.initializeApp()
  }
}

const auth = admin.auth()
const db = admin.firestore()

const adminEmail = process.env.VITE_ADMIN_EMAIL || process.env.ADMIN_EMAIL || 'admin@chat.local'
const adminPassword = process.env.VITE_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || 'ChangeMe123!'
const displayName = process.env.VITE_ADMIN_DISPLAY_NAME || process.env.ADMIN_DISPLAY_NAME || 'Controller'
const username = (adminEmail.split('@')[0] || 'admin').toLowerCase()

async function main() {
  let userRecord
  try {
    userRecord = await auth.getUserByEmail(adminEmail)
    console.log('Admin auth user exists:', userRecord.uid)
  } catch {
    userRecord = await auth.createUser({
      email: adminEmail,
      password: adminPassword,
      displayName,
    })
    console.log('Created admin auth user:', userRecord.uid)
  }

  await db.collection('users').doc(userRecord.uid).set({
    username,
    display_name: displayName,
    role: 'admin',
    suspended: false,
    is_online: false,
    created_at: admin.firestore.FieldValue.serverTimestamp(),
    last_seen: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true })

  console.log('Admin profile ensured in Firestore.')
  console.log(`Login username: ${username}`)
  console.log(`Login password: ${adminPassword}`)
  console.log('Sign in at /login; you will be routed to /admin.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
