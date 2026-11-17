import { createContext, useContext, useEffect, useState } from 'react'
import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'firebase/auth'
import { doc, getDoc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore'
import { auth, db } from '../lib/firebase'
import { PRESENCE_HEARTBEAT_MS, usernameToEmail } from '../utils/helpers'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [firebaseUser, setFirebaseUser] = useState(null)
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      setFirebaseUser(user)
      if (!user) {
        setProfile(null)
        setLoading(false)
        return
      }
      const snap = await getDoc(doc(db, 'users', user.uid))
      if (snap.exists()) {
        const data = { id: snap.id, ...snap.data() }
        setProfile(data)
      } else {
        setProfile(null)
      }
      setLoading(false)
    })
    return () => unsub()
  }, [])

  useEffect(() => {
    if (!firebaseUser || profile?.role !== 'user' || profile.suspended === true) return
    const ref = doc(db, 'users', firebaseUser.uid)
    const ping = () => {
      updateDoc(ref, { is_online: true, last_seen: serverTimestamp() }).catch(() => {})
    }
    const goOffline = () => {
      // Best-effort only: a killed tab may never flush this, which is why readers
      // also go by last_seen freshness (PRESENCE_STALE_MS) rather than this flag.
      setDoc(ref, { is_online: false, last_seen: serverTimestamp() }, { merge: true }).catch(() => {})
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') ping()
    }
    ping()
    const heartbeat = setInterval(ping, PRESENCE_HEARTBEAT_MS)
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', goOffline)
    window.addEventListener('beforeunload', goOffline)
    return () => {
      clearInterval(heartbeat)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', goOffline)
      window.removeEventListener('beforeunload', goOffline)
      goOffline()
    }
  }, [firebaseUser, profile])

  async function login(username, password) {
    const email = usernameToEmail(username)
    const cred = await signInWithEmailAndPassword(auth, email, password)
    const snap = await getDoc(doc(db, 'users', cred.user.uid))
    if (!snap.exists()) throw new Error('Account profile not found.')
    const data = snap.data()
    if (data.suspended) {
      await signOut(auth)
      throw new Error('This account has been suspended.')
    }
    return { id: snap.id, ...data }
  }

  async function logout() {
    if (firebaseUser && profile?.role === 'user') {
      await updateDoc(doc(db, 'users', firebaseUser.uid), {
        is_online: false,
        last_seen: serverTimestamp(),
      }).catch(() => {})
    }
    await signOut(auth)
  }

  return (
    <AuthContext.Provider value={{ firebaseUser, profile, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
