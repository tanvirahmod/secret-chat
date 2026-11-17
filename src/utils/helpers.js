export function usernameToEmail(username) {
  const normalized = String(username || '').trim().toLowerCase()
  return `${normalized}@chat.local`
}

export function connectionIdFor(a, b) {
  return [a, b].sort().join('__')
}

// Presence: a client refreshes last_seen on this cadence, and anyone older than
// PRESENCE_STALE_MS is treated as offline so a killed tab cannot stay "Online".
export const PRESENCE_HEARTBEAT_MS = 30 * 1000
export const PRESENCE_STALE_MS = PRESENCE_HEARTBEAT_MS * 3

export function timestampToMs(ts) {
  if (!ts) return 0
  if (typeof ts.toMillis === 'function') return ts.toMillis()
  if (typeof ts.seconds === 'number') return ts.seconds * 1000
  const ms = new Date(ts).getTime()
  return Number.isFinite(ms) ? ms : 0
}

export function isUserOnline(user, now = Date.now()) {
  if (user?.is_online !== true) return false
  const last = timestampToMs(user.last_seen)
  return last > 0 && now - last < PRESENCE_STALE_MS
}

export function formatLastSeen(user, now = Date.now()) {
  const last = timestampToMs(user?.last_seen)
  if (last === 0) return 'Last seen unknown'
  const diff = Math.max(0, now - last)
  if (diff < 60 * 1000) return 'Last seen just now'
  const minutes = Math.floor(diff / (60 * 1000))
  if (minutes < 60) return `Last seen ${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `Last seen ${hours} h ago`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'Last seen yesterday'
  if (days < 7) return `Last seen ${days} days ago`
  return `Last seen ${new Date(last).toLocaleDateString()}`
}

export function formatTime(ts) {
  if (!ts) return ''
  const d = ts.toDate ? ts.toDate() : new Date(ts)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function generatePassword(length = 12) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%*?'
  let out = ''
  const arr = new Uint32Array(length)
  crypto.getRandomValues(arr)
  for (let i = 0; i < length; i++) out += chars[arr[i] % chars.length]
  return out
}
