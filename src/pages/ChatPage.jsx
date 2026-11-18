import { useEffect, useMemo, useRef, useState } from 'react'
import {
  addDoc, arrayUnion, collection, deleteField, doc, limit, onSnapshot, orderBy, query, serverTimestamp, setDoc, updateDoc, where, writeBatch, getDocs,
} from 'firebase/firestore'
import EmojiPicker from 'emoji-picker-react'
import imageCompression from 'browser-image-compression'
import { v4 as uuidv4 } from 'uuid'
import {
  Bell, Check, CheckCheck, Copy, Eraser, Eye, EyeOff, ImagePlus, Menu, Mic, MoreHorizontal, Pause, Pencil, Play, Reply, Send, Smile, SmilePlus, Square, Trash2, X,
} from 'lucide-react'
import toast from 'react-hot-toast'
import { db } from '../lib/firebase'
import { useAuth } from '../contexts/AuthContext'
import { formatLastSeen, formatTime, isUserOnline, timestampToMs } from '../utils/helpers'

const CLOUDINARY_CLOUD_NAME = import.meta.env.VITE_CLOUDINARY_CLOUD_NAME
const CLOUDINARY_UPLOAD_PRESET = import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024
const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏']
const SWIPE_REPLY_PX = 48
const LONG_PRESS_MS = 450

// Messages older than the cutoff are hidden from this user. While a chat is
// hidden, the cutoff is the moment it was hidden, so new messages still show.
// A hidden chat whose hidden_at is still pending hides everything for a beat
// rather than flashing the old history.
function cutoffFor(prefs) {
  if (!prefs) return 0
  const cleared = prefs.clearedAt || 0
  if (!prefs.hidden) return cleared
  return prefs.hiddenAt == null ? Number.MAX_SAFE_INTEGER : Math.max(cleared, prefs.hiddenAt)
}

// Unsigned direct-to-Cloudinary upload: Storage for Firebase requires the Blaze plan.
// The preset enforces allowed_formats; size has to be enforced here (presets can't).
async function uploadToCloudinary(file, resourceType) {
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_UPLOAD_PRESET) {
    throw new Error('Media upload is not configured (set VITE_CLOUDINARY_CLOUD_NAME and VITE_CLOUDINARY_UPLOAD_PRESET).')
  }
  const form = new FormData()
  form.append('file', file)
  form.append('upload_preset', CLOUDINARY_UPLOAD_PRESET)
  const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/${resourceType}/upload`, {
    method: 'POST',
    body: form,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.error?.message || `Upload failed (HTTP ${res.status})`)
  if (!data.secure_url) throw new Error('Upload failed (no URL returned).')
  return data.secure_url
}

function useRecorder() {
  const [recording, setRecording] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const mediaRef = useRef(null)
  const chunksRef = useRef([])
  const timerRef = useRef(null)

  async function start() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const mr = new MediaRecorder(stream)
    chunksRef.current = []
    mr.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data) }
    mediaRef.current = mr
    mr.start()
    setRecording(true)
    setSeconds(0)
    timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1000)
  }

  function stop() {
    return new Promise((resolve) => {
      const mr = mediaRef.current
      if (!mr) return resolve(null)
      mr.onstop = () => {
        clearInterval(timerRef.current)
        setRecording(false)
        mr.stream.getTracks().forEach((t) => t.stop())
        const blob = new Blob(chunksRef.current, { type: mr.mimeType || 'audio/webm' })
        resolve(blob)
      }
      mr.stop()
    })
  }

  function cancel() {
    const mr = mediaRef.current
    if (mr && mr.state !== 'inactive') {
      mr.onstop = () => {
        clearInterval(timerRef.current)
        setRecording(false)
        mr.stream.getTracks().forEach((t) => t.stop())
      }
      mr.stop()
    } else {
      clearInterval(timerRef.current)
      setRecording(false)
    }
  }

  return { recording, seconds, start, stop, cancel }
}

function AudioBubble({ url }) {
  const audioRef = useRef(null)
  const [playing, setPlaying] = useState(false)
  const [duration, setDuration] = useState(0)
  useEffect(() => {
    const a = audioRef.current
    if (!a) return
    const onLoaded = () => setDuration(a.duration || 0)
    const onEnd = () => setPlaying(false)
    a.addEventListener('loadedmetadata', onLoaded)
    a.addEventListener('ended', onEnd)
    return () => { a.removeEventListener('loadedmetadata', onLoaded); a.removeEventListener('ended', onEnd) }
  }, [url])
  const toggle = () => {
    const a = audioRef.current
    if (!a) return
    if (playing) { a.pause(); setPlaying(false) } else { a.play(); setPlaying(true) }
  }
  const fmt = (s) => {
    if (!isFinite(s)) return '0:00'
    const m = Math.floor(s / 60)
    const sec = Math.floor(s % 60).toString().padStart(2, '0')
    return `${m}:${sec}`
  }
  return (
    <div className="flex items-center gap-2 min-w-[180px]">
      <button onClick={toggle} className="h-8 w-8 rounded-full bg-white/20 flex items-center justify-center">{playing ? <Pause size={16} /> : <Play size={16} />}</button>
      <div className="flex-1">
        <div className="h-1.5 bg-white/20 rounded-full overflow-hidden"><div className="h-full bg-white/70 rounded-full" style={{ width: audioRef.current && duration ? `${(audioRef.current.currentTime / duration) * 100}%` : '0%' }} /></div>
        <div className="text-xs opacity-80 mt-1">{fmt(duration || 0)}</div>
      </div>
      <audio ref={audioRef} src={url} preload="metadata" />
    </div>
  )
}

export default function ChatPage() {
  const { profile, logout } = useAuth()
  const [connections, setConnections] = useState([])
  const [usersById, setUsersById] = useState({})
  const [active, setActive] = useState(null) // { id, peer }
  const [messages, setMessages] = useState([])
  const [text, setText] = useState('')
  const [pendingAudio, setPendingAudio] = useState(null) // recorded, waiting for the user to send or discard
  const [sendingAudio, setSendingAudio] = useState(false)
  const [editing, setEditing] = useState(null) // { id, value } while a text message is being edited
  const [deleteTarget, setDeleteTarget] = useState(null) // message awaiting delete-for-me / delete-for-everyone
  const [menuFor, setMenuFor] = useState(null) // message opened by long-press / right-click
  const [replyTo, setReplyTo] = useState(null) // { id, sender_id, type, content } staged reply
  const [dragX, setDragX] = useState({ id: null, x: 0 }) // horizontal swipe offset for reply
  const [selectMode, setSelectMode] = useState(false) // multi-select for bulk delete
  const [selected, setSelected] = useState([]) // message ids picked in select mode
  const [chatPrefs, setChatPrefs] = useState({}) // connectionId -> { hidden, clearedAt }
  const [chatMenu, setChatMenu] = useState(null) // contact opened by long-press / ⋯ button
  const [prefsLoaded, setPrefsLoaded] = useState(false) // hold the list until prefs land, so history never flashes
  const [showReactionPicker, setShowReactionPicker] = useState(false) // full emoji picker inside the message sheet
  const [notifPermission, setNotifPermission] = useState(() => (typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : 'unsupported'))
  const [notificationsOn, setNotificationsOn] = useState(true)
  const [showEmoji, setShowEmoji] = useState(false)
  const [typingPeer, setTypingPeer] = useState(false)
  const [lightbox, setLightbox] = useState(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [unread, setUnread] = useState({})
  const messagesEndRef = useRef(null)
  const typingTimeout = useRef(null)
  const recorder = useRecorder()
  const fileInputRef = useRef(null)
  const pendingAudioUrlRef = useRef(null)
  const composerRef = useRef(null)
  const pressTimer = useRef(null)
  const contactPressTimer = useRef(null)
  const gesture = useRef(null)
  const defaultsApplied = useRef(new Set()) // connections already re-hidden for this sign-in
  const notifiedIds = useRef(new Set()) // message ids already considered for a notification
  const primedConnections = useRef(new Set()) // first snapshot per chat is history, not news
  const activeRef = useRef(null)
  const openNotifications = useRef([])
  const swRegistration = useRef(null) // notification-capable service worker (Android needs one)
  const notificationsOnRef = useRef(true)
  const prefTouched = useRef(false) // don't let a late profile load undo the user's toggle
  const suppressClick = useRef(false) // swallow the click that follows a long-press
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => () => {
    if (pendingAudioUrlRef.current) URL.revokeObjectURL(pendingAudioUrlRef.current)
  }, [])

  useEffect(() => { if (!menuFor) setShowReactionPicker(false) }, [menuFor])

  useEffect(() => { activeRef.current = active }, [active])

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    navigator.serviceWorker.register('/sw.js')
      .then((reg) => { swRegistration.current = reg })
      .catch((err) => console.error('service worker', err))
  }, [])

  useEffect(() => { notificationsOnRef.current = notificationsOn }, [notificationsOn])

  // Restore the saved switch the first time the profile arrives.
  useEffect(() => {
    if (prefTouched.current || !profile) return
    setNotificationsOn(profile.notifications !== false)
  }, [profile])

  async function toggleNotifications() {
    const next = !notificationsOn
    prefTouched.current = true
    if (next) {
      if (typeof Notification === 'undefined') {
        toast.error('This browser does not support notifications.')
        return
      }
      if (Notification.permission === 'denied') {
        toast.error('Notifications are blocked for this site in your browser settings.')
        return
      }
      if (Notification.permission !== 'granted') {
        const permission = await Notification.requestPermission()
        setNotifPermission(permission)
        if (permission !== 'granted') { toast.error('Notifications blocked.'); return }
      }
    }
    setNotificationsOn(next)
    try {
      await updateDoc(doc(db, 'users', profile.id), { notifications: next })
    } catch (err) {
      toast.error(err.message || 'Could not save the notification setting')
    }
  }

  // Browser notification for a message that arrives while it can't be seen:
  // either the tab is in the background or another chat is open.
  function notifyNewMessage(c) {
    if (!notificationsOnRef.current) return
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
    if (document.visibilityState === 'visible' && activeRef.current?.connectionId === c.connectionId) return
    // Deliberately generic: no sender name and no message text on screen.
    const options = { tag: `chat-${c.connectionId}`, renotify: true, silent: false }
    if (swRegistration.current) {
      // Android Chrome rejects the page-level constructor; this path also works
      // on desktop, and the worker focuses the app when the notification is clicked.
      swRegistration.current.showNotification('You Got New Text', options)
        .catch((err) => console.error('notification', err))
      return
    }
    try {
      const n = new Notification('You Got New Text', options)
      n.onclick = () => { window.focus(); setActive(c); n.close() }
      openNotifications.current.push(n)
      if (openNotifications.current.length > 20) openNotifications.current.shift()
    } catch (err) {
      console.error('notification', err)
    }
  }

  // Grow the composer so the whole message is visible, scrolling past max-h-48 (192px).
  useEffect(() => {
    const el = composerRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 192)}px`
  }, [text])

  // Presence is derived from a fresh last_seen, so a peer who closed the tab or
  // dropped offline decays to "offline" even without a write landing.
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 15000)
    return () => clearInterval(tick)
  }, [])

  useEffect(() => {
    if (!profile?.id) return
    const q1 = query(collection(db, 'connections'), where('user_one_id', '==', profile.id))
    const q2 = query(collection(db, 'connections'), where('user_two_id', '==', profile.id))
    const apply = (snap, which) => {
      setConnections((prev) => {
        const other = prev.filter((c) => c._which !== which)
        const mine = snap.docs.map((d) => ({ id: d.id, ...d.data(), _which: which }))
        const merged = [...other, ...mine]
        const uniq = Array.from(new Map(merged.map((c) => [c.id, c])).values())
        return uniq
      })
    }
    const onErr = (label) => (err) => console.error(label, err)
    const u1 = onSnapshot(q1, (s) => apply(s, 'one'), onErr('connections q1'))
    const u2 = onSnapshot(q2, (s) => apply(s, 'two'), onErr('connections q2'))
    return () => { u1(); u2() }
  }, [profile?.id])

  useEffect(() => {
    if (!profile?.id) return
    const peerIds = Array.from(new Set(connections.map((c) => (c.user_one_id === profile.id ? c.user_two_id : c.user_one_id)).filter(Boolean)))
    if (peerIds.length === 0) {
      setUsersById((prev) => (prev[profile.id] ? { [profile.id]: prev[profile.id] } : {}))
      return
    }
    setUsersById((prev) => {
      const next = {}
      peerIds.forEach((id) => { if (prev[id]) next[id] = prev[id] })
      if (prev[profile.id]) next[profile.id] = prev[profile.id]
      return next
    })
    const unsubs = peerIds.map((id) =>
      onSnapshot(doc(db, 'users', id), (snap) => {
        if (!snap.exists()) return
        setUsersById((prev) => ({ ...prev, [id]: { id: snap.id, ...snap.data() } }))
      }, (err) => console.error('user listener', id, err))
    )
    return () => unsubs.forEach((u) => u())
  }, [profile?.id, connections])

  // Per-user chat state (hidden / cleared) lives under the user's own document,
  // so a hidden or cleared chat never affects the other participant.
  useEffect(() => {
    if (!profile?.id) return
    const unsub = onSnapshot(collection(db, 'users', profile.id, 'chat_prefs'), (snap) => {
      const next = {}
      snap.docs.forEach((d) => {
        const data = d.data()
        next[d.id] = {
          hidden: data.hidden === true,
          clearedAt: data.cleared_at?.toMillis ? data.cleared_at.toMillis() : 0,
          hiddenAt: data.hidden_at?.toMillis ? data.hidden_at.toMillis() : null,
        }
      })
      setChatPrefs(next)
      setPrefsLoaded(true)
    }, (err) => console.error('chat prefs listener', err))
    return () => unsub()
  }, [profile?.id])

  const contacts = useMemo(() => {
    return connections.map((c) => {
      const peerId = c.user_one_id === profile.id ? c.user_two_id : c.user_one_id
      return { connectionId: c.id, peerId, peer: usersById[peerId], connection: c, online: isUserOnline(usersById[peerId], now) }
    }).filter((c) => c.peer && c.peer.role === 'user' && !c.peer.suspended)
      .sort((a, b) => (a.peer.display_name || '').localeCompare(b.peer.display_name || ''))
  }, [connections, usersById, profile?.id, now])

  // Every sign-in starts hidden: the old history sits behind "Show chat", while
  // messages that arrive from now on are visible. Runs once per connection per
  // session, so pressing "Show chat" is never undone by this effect.
  useEffect(() => {
    if (!profile?.id || contacts.length === 0) return
    const pending = contacts.filter((c) => !defaultsApplied.current.has(c.connectionId))
    if (pending.length === 0) return
    pending.forEach((c) => defaultsApplied.current.add(c.connectionId))
    const batch = writeBatch(db)
    pending.forEach((c) => {
      batch.set(doc(db, 'users', profile.id, 'chat_prefs', c.connectionId), {
        connection_id: c.connectionId,
        hidden: true,
        hidden_at: serverTimestamp(),
        updated_at: serverTimestamp(),
      }, { merge: true })
    })
    batch.commit().catch((err) => console.error('chat defaults', err))
  }, [profile?.id, contacts])

  useEffect(() => {
    if (!profile?.id || contacts.length === 0) { setUnread({}); return }
    const unsubs = contacts.map((c) => {
      const q = query(collection(db, 'messages'), where('connection_id', '==', c.connectionId), where('is_read', '==', false))
            return onSnapshot(q, (snap) => {
        const cutoff = cutoffFor(chatPrefs[c.connectionId])
        const primed = primedConnections.current.has(c.connectionId)
        primedConnections.current.add(c.connectionId)
        let count = 0
        snap.docs.forEach((d) => {
          const data = d.data()
          const visible = data.sender_id !== profile.id
            && data.deleted !== true
            && !(data.deleted_for || []).includes(profile.id)
            && (data.created_at ? timestampToMs(data.created_at) > cutoff : true)
          if (visible) count += 1
          // The first snapshot is existing history; later ones carry new mail.
          if (!notifiedIds.current.has(d.id)) {
            notifiedIds.current.add(d.id)
            if (primed && visible) notifyNewMessage(c)
          }
        })
        setUnread((prev) => ({ ...prev, [c.connectionId]: count }))
      }, (err) => console.error('unread listener', c.connectionId, err))
    })
    return () => unsubs.forEach((u) => u())
  }, [contacts.map((c) => c.connectionId).join('|'), profile?.id, chatPrefs])

  useEffect(() => {
    if (!active?.connectionId) { setMessages([]); return }
    const q = query(collection(db, 'messages'), where('connection_id', '==', active.connectionId), orderBy('created_at', 'asc'), limit(500))
    const unsub = onSnapshot(q, async (snap) => {
      // Removed messages stay on the server: either hidden for one user
      // (`deleted_for`) or for both (`deleted`).
      const cutoff = cutoffFor(chatPrefs[active.connectionId])
      const msgs = snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .filter((m) => m.deleted !== true
          && !(m.deleted_for || []).includes(profile.id)
          && (m.created_at ? timestampToMs(m.created_at) > cutoff : true))
      setMessages(msgs)
      // Only the messages actually on screen get marked as seen.
      const batch = writeBatch(db)
      let changed = false
      msgs.forEach((m) => {
        if (m.sender_id !== profile.id && !m.is_read) {
          batch.update(doc(db, 'messages', m.id), { is_read: true, seen_at: serverTimestamp() })
          changed = true
        }
      })
      if (changed) await batch.commit().catch(() => {})
    }, (err) => console.error('messages listener', active.connectionId, err))
    return () => unsub()
  }, [active?.connectionId, profile?.id, chatPrefs])

  useEffect(() => {
    if (!active?.connectionId || !active?.peerId) { setTypingPeer(false); return }
    const typingDocId = `${active.connectionId}_${active.peerId}`
    const unsub = onSnapshot(doc(db, 'typing', typingDocId), (snap) => {
      if (!snap.exists()) return setTypingPeer(false)
      const data = snap.data()
      const ts = data.updated_at?.toMillis ? data.updated_at.toMillis() : 0
      setTypingPeer(!!data.typing && Date.now() - ts < 4000)
    }, (err) => console.error('typing listener', typingDocId, err))
    const interval = setInterval(() => {
      // re-evaluate staleness
      setTypingPeer((v) => v)
    }, 2000)
    return () => { unsub(); clearInterval(interval) }
  }, [active?.connectionId, active?.peerId])

  const activePrefs = active ? chatPrefs[active.connectionId] : null
  const activeCutoff = useMemo(() => cutoffFor(activePrefs), [activePrefs])
  const visibleMessages = useMemo(() => {
    if (!prefsLoaded) return []
    return messages.filter((m) => !m.created_at || timestampToMs(m.created_at) > activeCutoff)
  }, [messages, activeCutoff, prefsLoaded])

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [visibleMessages])

  async function setTyping(isTyping) {
    if (!active?.connectionId || !profile?.id) return
    const typingDocId = `${active.connectionId}_${profile.id}`
    await setDoc(doc(db, 'typing', typingDocId), {
      connection_id: active.connectionId,
      user_id: profile.id,
      typing: isTyping,
      updated_at: serverTimestamp(),
    }, { merge: true }).catch(() => {})
  }

  function onTextChange(e) {
    setText(e.target.value)
    setTyping(true)
    clearTimeout(typingTimeout.current)
    typingTimeout.current = setTimeout(() => setTyping(false), 2000)
  }

  async function sendText(e) {
    e?.preventDefault()
    const content = text.trim()
    if (!content || !active) return
    setText('')
    setShowEmoji(false)
    setTyping(false)
    const reply = replyTo ? { reply_to: replyTo } : {}
    try {
      await addDoc(collection(db, 'messages'), {
        connection_id: active.connectionId,
        sender_id: profile.id,
        type: 'text',
        content,
        is_read: false,
        created_at: serverTimestamp(),
        ...reply,
      })
      if (replyTo) setReplyTo(null)
    } catch (err) { toast.error(err.message || 'Failed to send') }
  }

  async function uploadFile(file, type) {
    if (!active) return false
    try {
      let uploadFileObj = file
      if (type === 'image') {
        uploadFileObj = await imageCompression(file, { maxSizeMB: 1, maxWidthOrHeight: 1600, useWebWorker: true })
      }
      if (uploadFileObj.size > MAX_UPLOAD_BYTES) {
        toast.error('File is too large (max 10 MB).')
        return false
      }
      const url = await uploadToCloudinary(uploadFileObj, type === 'image' ? 'image' : 'video')
      await addDoc(collection(db, 'messages'), {
        connection_id: active.connectionId,
        sender_id: profile.id,
        type,
        content: url,
        is_read: false,
        created_at: serverTimestamp(),
        file_name: file.name || '',
        ...(replyTo ? { reply_to: replyTo } : {}),
      })
      if (replyTo) setReplyTo(null)
      return true
    } catch (err) {
      console.error(err)
      toast.error(err.message || 'Upload failed')
      return false
    }
  }

  async function onPickImage(e) {
    const file = e.target.files?.[0]
    if (file) await uploadFile(file, 'image')
    e.target.value = ''
  }

  function clearPendingAudio() {
    if (pendingAudioUrlRef.current) {
      URL.revokeObjectURL(pendingAudioUrlRef.current)
      pendingAudioUrlRef.current = null
    }
    setPendingAudio(null)
  }

  async function toggleRecord() {
    if (recorder.recording) {
      const blob = await recorder.stop()
      if (blob && blob.size > 0) {
        const file = new File([blob], `voice-${Date.now()}.webm`, { type: blob.type || 'audio/webm' })
        clearPendingAudio()
        pendingAudioUrlRef.current = URL.createObjectURL(file)
        setPendingAudio({ file, url: pendingAudioUrlRef.current })
      }
    } else {
      try { await recorder.start() } catch { toast.error('Microphone access denied') }
    }
  }

  async function sendPendingAudio() {
    if (!pendingAudio || sendingAudio) return
    setSendingAudio(true)
    try {
      // Keep the recording around if the upload fails, so it can be retried.
      const sent = await uploadFile(pendingAudio.file, 'audio')
      if (sent) clearPendingAudio()
    } finally {
      setSendingAudio(false)
    }
  }

  async function deleteForMe(m) {
    setDeleteTarget(null)
    try {
      // Hides the message for this user only; the other participant keeps it.
      await updateDoc(doc(db, 'messages', m.id), { deleted_for: arrayUnion(profile.id) })
    } catch (err) {
      toast.error(err.message || 'Could not delete this message')
    }
  }

  async function deleteForEveryone(m) {
    setDeleteTarget(null)
    try {
      // Hides the message for both participants; the document and any media
      // uploaded to Cloudinary stay on the server.
      await updateDoc(doc(db, 'messages', m.id), {
        deleted: true,
        deleted_by: profile.id,
        deleted_at: serverTimestamp(),
      })
    } catch (err) {
      toast.error(err.message || 'Could not delete this message')
    }
  }

  // Bulk delete: one batched write per selected message. Each document is still
  // validated on its own by the rules, and nothing is removed from the server.
  async function bulkDelete(forEveryone) {
    const ids = [...selected]
    if (!ids.length) return
    if (forEveryone && !window.confirm(`Delete ${ids.length} message${ids.length > 1 ? 's' : ''} for both of you?`)) return
    const batch = writeBatch(db)
    ids.forEach((id) => {
      batch.update(doc(db, 'messages', id), forEveryone
        ? { deleted: true, deleted_by: profile.id, deleted_at: serverTimestamp() }
        : { deleted_for: arrayUnion(profile.id) })
    })
    try {
      await batch.commit()
      exitSelect()
    } catch (err) {
      toast.error(err.message || 'Could not delete the selected messages')
    }
  }

  function startEdit(m) {
    setEditing({ id: m.id, value: m.content })
  }

  async function saveEdit(m) {
    if (!editing) return
    const content = editing.value.trim()
    if (!content) { toast.error('Message cannot be empty.'); return }
    if (content === m.content) { setEditing(null); return }
    try {
      await updateDoc(doc(db, 'messages', m.id), { content, edited_at: serverTimestamp() })
      setEditing(null)
    } catch (err) {
      toast.error(err.message || 'Could not edit message')
    }
  }

  function previewOf(msg) {
    if (!msg) return ''
    if (msg.type === 'image') return 'Photo'
    if (msg.type === 'audio') return 'Voice note'
    return msg.content || ''
  }

  function startReply(m) {
    setMenuFor(null)
    setReplyTo({ id: m.id, sender_id: m.sender_id, type: m.type, content: m.content })
    requestAnimationFrame(() => composerRef.current?.focus())
  }

  async function react(m, emoji) {
    setMenuFor(null)
    const current = m[`reaction_${profile.id}`]
    try {
      // Own field only: rules reject any other key, so reactions can't be forged.
      await updateDoc(doc(db, 'messages', m.id), {
        [`reaction_${profile.id}`]: current === emoji ? deleteField() : emoji,
      })
    } catch (err) {
      toast.error(err.message || 'Could not react')
    }
  }

  function cancelPress() {
    if (pressTimer.current) { clearTimeout(pressTimer.current); pressTimer.current = null }
  }

  function startPress(m) {
    cancelPress()
    pressTimer.current = setTimeout(() => {
      pressTimer.current = null
      suppressClick.current = true
      setTimeout(() => { suppressClick.current = false }, 600)
      navigator.vibrate?.(10)
      setMenuFor(m)
    }, LONG_PRESS_MS)
  }

  function resetGesture() {
    cancelPress()
    gesture.current = null
    setDragX({ id: null, x: 0 })
  }

  // Swipe a bubble to the right to reply; holding it opens the action sheet.
  function onBubbleTouchStart(m, e) {
    if (e.touches.length !== 1 || e.target.closest('button')) return
    if (selectMode) return // in select mode a tap toggles instead of dragging
    gesture.current = { id: m.id, message: m, startX: e.touches[0].clientX, startY: e.touches[0].clientY, dx: 0, swiping: false }
    setDragX({ id: null, x: 0 })
    startPress(m)
  }

  function onBubbleTouchMove(e) {
    const g = gesture.current
    if (!g || e.touches.length !== 1) return
    const dx = e.touches[0].clientX - g.startX
    const dy = e.touches[0].clientY - g.startY
    if (!g.swiping) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return
      // Vertical movement (scrolling) or a leftward swipe abandons the gesture.
      if (dx <= 0 || Math.abs(dy) >= Math.abs(dx)) { resetGesture(); return }
      g.swiping = true
      cancelPress()
    }
    g.dx = Math.min(dx, 72)
    setDragX({ id: g.id, x: g.dx })
  }

  function onBubbleTouchEnd() {
    const g = gesture.current
    if (g?.swiping && g.dx >= SWIPE_REPLY_PX) startReply(g.message)
    resetGesture()
  }

  function cancelContactPress() {
    if (contactPressTimer.current) { clearTimeout(contactPressTimer.current); contactPressTimer.current = null }
  }

  function startContactPress(c) {
    cancelContactPress()
    contactPressTimer.current = setTimeout(() => {
      contactPressTimer.current = null
      navigator.vibrate?.(10)
      setChatMenu(c)
    }, LONG_PRESS_MS)
  }

  async function setChatHidden(c, hidden) {
    setChatMenu(null)
    try {
      await setDoc(doc(db, 'users', profile.id, 'chat_prefs', c.connectionId), {
        connection_id: c.connectionId,
        hidden,
        // Hiding starts the cutoff at now; showing drops it back to the cleared mark.
        hidden_at: hidden ? serverTimestamp() : null,
        updated_at: serverTimestamp(),
      }, { merge: true })
    } catch (err) {
      toast.error(err.message || 'Could not update this chat')
    }
  }

  async function clearChat(c) {
    setChatMenu(null)
    if (!window.confirm('Clear this chat? The messages are hidden for you only and stay on the server.')) return
    try {
      // Cleared = a timestamp: everything older is hidden for this user, newer
      // messages keep arriving, and nothing is deleted from Firestore.
      await setDoc(doc(db, 'users', profile.id, 'chat_prefs', c.connectionId), {
        connection_id: c.connectionId,
        cleared_at: serverTimestamp(),
        hidden: false,
        updated_at: serverTimestamp(),
      }, { merge: true })
    } catch (err) {
      toast.error(err.message || 'Could not clear this chat')
    }
  }

  function toggleSelect(id) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  function exitSelect() {
    setSelectMode(false)
    setSelected([])
  }

  function renderReceipt(m) {
    if (m.sender_id !== profile.id) return null
    return m.is_read
      ? <CheckCheck size={14} className="text-sky-300" />
      : <Check size={14} className="opacity-70" />
  }

  const activePeer = active ? usersById[active.peerId] : null
  const activeOnline = isUserOnline(activePeer, now)

  return (
    <div className="h-full flex bg-slate-950 text-slate-100 overflow-hidden">
      <aside className={`w-full sm:w-80 md:w-96 border-r border-slate-800 bg-slate-900 flex flex-col ${active ? 'hidden sm:flex' : 'flex'} ${sidebarOpen ? '!flex absolute inset-0 z-20 sm:static' : ''}`}>
        <div className="p-4 border-b border-slate-800 flex items-center justify-between">
          <div>
            <div className="font-semibold">{profile?.display_name}</div>
            <div className="text-xs text-slate-400">@{profile?.username}</div>
          </div>
          <button onClick={logout} className="px-3 py-2 rounded-lg text-sm font-medium text-slate-300 hover:bg-slate-800 hover:text-white">Sign out</button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {contacts.length === 0 && <p className="p-4 text-sm text-slate-500">No approved contacts yet. Ask the Controller to connect you.</p>}
          {contacts.map((c) => {
            const prefs = chatPrefs[c.connectionId] || {}
            return (
              <div key={c.connectionId}
                role="button" tabIndex={0}
                onClick={() => { setActive(c); setSidebarOpen(false); exitSelect() }}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setActive(c); setSidebarOpen(false); exitSelect() } }}
                onTouchStart={() => startContactPress(c)}
                onTouchEnd={cancelContactPress}
                onTouchMove={cancelContactPress}
                onTouchCancel={cancelContactPress}
                onContextMenu={(e) => { e.preventDefault(); setChatMenu(c) }}
                className={`group w-full text-left px-4 py-3 border-b border-slate-800/60 hover:bg-slate-800/60 flex items-center gap-3 cursor-pointer ${active?.connectionId === c.connectionId ? 'bg-slate-800' : ''}`}>
                <div className="relative">
                  <div className="h-10 w-10 rounded-full bg-indigo-700 flex items-center justify-center font-semibold">{(c.peer.display_name || '?')[0].toUpperCase()}</div>
                  <span className={`absolute bottom-0 right-0 h-3 w-3 rounded-full border-2 border-slate-900 ${c.online ? 'bg-emerald-400' : 'bg-slate-500'}`} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className={`font-medium truncate ${prefs.hidden ? 'text-slate-400' : ''}`}>{c.peer.display_name}</span>
                    {unread[c.connectionId] > 0 && <span className="text-xs bg-indigo-600 text-white rounded-full px-2 py-0.5">{unread[c.connectionId]}</span>}
                  </div>
                  <div className="text-xs text-slate-400 truncate">
                    {prefs.hidden
                      ? <span className="inline-flex items-center gap-1"><EyeOff size={12} />Chat hidden</span>
                      : (c.online ? 'Online' : formatLastSeen(c.peer, now))}
                  </div>
                </div>
                <button type="button" onClick={(e) => { e.stopPropagation(); setChatMenu(c) }}
                  className="shrink-0 p-1.5 rounded-lg text-slate-400 hover:bg-slate-700 hover:text-white sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
                  title="Chat options"><MoreHorizontal size={16} /></button>
              </div>
            )
          })}
        </div>
        <div className="border-t border-slate-800 px-4 py-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm text-slate-200"><Bell size={14} />Notifications</div>
            <div className="truncate text-[11px] text-slate-500">
              {notifPermission === 'denied'
                ? 'Blocked in browser settings'
                : notificationsOn ? 'New message alerts on' : 'Alerts off'}
            </div>
          </div>
          <button type="button" role="switch" aria-checked={notificationsOn} onClick={toggleNotifications}
            className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${notificationsOn ? 'bg-indigo-600' : 'bg-slate-700'}`}>
            <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${notificationsOn ? 'left-[22px]' : 'left-0.5'}`} />
          </button>
        </div>
      </aside>

      <section className={`flex-1 flex flex-col min-w-0 ${!active ? 'hidden sm:flex' : 'flex'}`}>
        {!active ? (
          <div className="flex-1 flex items-center justify-center text-slate-500">Select a contact to start chatting</div>
        ) : (
          <>
            <header className="h-16 border-b border-slate-800 px-4 flex items-center gap-3 bg-slate-900/50">
              <button className="sm:hidden p-2 -ml-2 rounded hover:bg-slate-800" onClick={() => { setActive(null); setSidebarOpen(true) }}><Menu size={18} /></button>
              <div className="relative">
                <div className="h-9 w-9 rounded-full bg-indigo-700 flex items-center justify-center font-semibold">{(activePeer?.display_name || '?')[0].toUpperCase()}</div>
                <span className={`absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-slate-900 ${activeOnline ? 'bg-emerald-400' : 'bg-slate-500'}`} />
              </div>
              <div className="min-w-0">
                <div className="font-medium truncate">{activePeer?.display_name}</div>
                <div className="text-xs text-slate-400 h-4">
                  {typingPeer ? <span className="text-emerald-400">{activePeer?.display_name} is typing...</span> : (activeOnline ? 'Online' : formatLastSeen(activePeer, now))}
                </div>
              </div>
            </header>

            {selectMode && (
              <div className="flex items-center gap-2 border-b border-slate-800 bg-slate-900 px-3 py-2">
                <button type="button" onClick={exitSelect} className="p-1.5 rounded hover:bg-slate-800" title="Cancel selection"><X size={18} /></button>
                <div className="text-sm font-medium">{selected.length} selected</div>
                <div className="ml-auto flex items-center gap-2">
                  <button type="button" onClick={() => bulkDelete(false)} disabled={!selected.length} className="rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-50 px-2.5 py-1.5 text-xs">Delete for me</button>
                  <button type="button" onClick={() => bulkDelete(true)} disabled={!selected.length} className="rounded-lg bg-red-600 hover:bg-red-500 disabled:opacity-50 px-2.5 py-1.5 text-xs">Delete for everyone</button>
                </div>
              </div>
            )}

            {activePrefs?.hidden && (
              <div className="flex items-center gap-2 border-b border-slate-800 bg-slate-900 px-3 py-2 text-xs text-slate-400">
                <EyeOff size={14} />
                <span className="truncate">Earlier messages are hidden. New messages still appear.</span>
                <button type="button" onClick={() => setChatHidden(active, false)} className="ml-auto shrink-0 rounded-lg bg-slate-800 hover:bg-slate-700 px-2.5 py-1.5 text-xs text-white">Show chat</button>
              </div>
            )}
            <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-slate-950">
              {visibleMessages.map((m) => {
                const mine = m.sender_id === profile.id
                const myReaction = m[`reaction_${profile.id}`]
                const peerReaction = active?.peerId ? m[`reaction_${active.peerId}`] : null
                const dragging = dragX.id === m.id
                return (
                  <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                    <div className="group relative max-w-[85%] sm:max-w-[70%]">
                      <div className={`absolute -top-4 z-10 hidden sm:flex items-center gap-0.5 rounded-full border border-slate-700 bg-slate-900/95 px-1 py-0.5 shadow opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 ${mine ? 'right-0' : 'left-0'}`}>
                        <button type="button" onClick={() => setMenuFor(m)} className="p-1.5 rounded-full text-slate-300 hover:bg-slate-800 hover:text-white" title="React"><Smile size={14} /></button>
                        <button type="button" onClick={() => startReply(m)} className="p-1.5 rounded-full text-slate-300 hover:bg-slate-800 hover:text-white" title="Reply"><Reply size={14} /></button>
                        <button type="button" onClick={() => setMenuFor(m)} className="p-1.5 rounded-full text-slate-300 hover:bg-slate-800 hover:text-white" title="More"><MoreHorizontal size={14} /></button>
                      </div>
                      {dragging && dragX.x > 6 && (
                        <div className="absolute -left-4 top-1/2 -translate-y-1/2 text-slate-400" style={{ opacity: Math.min(dragX.x / SWIPE_REPLY_PX, 1) }}><Reply size={18} /></div>
                      )}
                      <div className="flex flex-col min-w-0">
                      <div
                        onTouchStart={(e) => onBubbleTouchStart(m, e)}
                        onTouchMove={onBubbleTouchMove}
                        onTouchEnd={onBubbleTouchEnd}
                        onTouchCancel={resetGesture}
                        onContextMenu={(e) => { e.preventDefault(); if (selectMode) { toggleSelect(m.id); return } setMenuFor(m) }}
                        onClick={(e) => { if (!selectMode || e.target.closest('button')) return; toggleSelect(m.id) }}
                        style={{ transform: dragging ? `translateX(${dragX.x}px)` : undefined }}
                        className={`rounded-2xl px-3 py-2 ${selected.includes(m.id) ? 'ring-2 ring-sky-400' : ''} ${dragging ? '' : 'transition-transform duration-150'} ${mine ? 'bg-indigo-600 text-white rounded-br-md' : 'bg-slate-800 text-slate-100 rounded-bl-md'}`}
                      >
                      {m.reply_to && (
                        <div className="mb-1 rounded-md border-l-2 border-white/50 bg-black/20 px-2 py-1">
                          <div className={`text-[11px] font-medium ${mine ? 'text-indigo-100' : 'text-indigo-300'}`}>{m.reply_to.sender_id === profile.id ? 'You' : (activePeer?.display_name || 'Them')}</div>
                          <div className="truncate text-xs opacity-80">{previewOf(m.reply_to)}</div>
                        </div>
                      )}
                      {m.type === 'text' && (editing?.id === m.id ? (
                        <div className="min-w-[180px]">
                          <textarea
                            value={editing.value}
                            onChange={(e) => setEditing({ id: m.id, value: e.target.value })}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(m) }
                              if (e.key === 'Escape') setEditing(null)
                            }}
                            rows={2}
                            autoFocus
                            className="w-full resize-none rounded-lg bg-black/20 px-2 py-1.5 outline-none focus:ring-1 focus:ring-white/40"
                          />
                          <div className="flex items-center gap-1 mt-1 text-[11px]">
                            <button type="button" onClick={() => saveEdit(m)} className="px-2 py-0.5 rounded bg-white/25 hover:bg-white/40 text-white">Save</button>
                            <button type="button" onClick={() => setEditing(null)} className="px-2 py-0.5 rounded hover:bg-white/10">Cancel</button>
                          </div>
                        </div>
                      ) : (
                        <p className="whitespace-pre-wrap break-words">{m.content}</p>
                      ))}
                      {m.type === 'image' && (
                        <img src={m.content} alt="attachment" className="max-h-72 rounded-lg cursor-pointer object-cover" onClick={(e) => { if (selectMode) { e.stopPropagation(); toggleSelect(m.id); return } if (suppressClick.current) return; setLightbox(m.content) }} />
                      )}
                      {m.type === 'audio' && <AudioBubble url={m.content} />}
                      <div className={`flex items-center gap-1 mt-1 text-[11px] ${mine ? 'text-indigo-100 justify-end' : 'text-slate-400'}`}>
                        <span>{formatTime(m.created_at)}{m.edited_at ? ' · edited' : ''}</span>
                        {renderReceipt(m)}
                      </div>
                      </div>
                      {(myReaction || peerReaction) && (
                        <div className={`mt-1 flex gap-1 ${mine ? 'justify-end' : 'justify-start'}`}>
                          {myReaction && <span className="rounded-full bg-slate-800/90 px-1.5 py-0.5 text-[11px] ring-1 ring-slate-700" title="You">{myReaction}</span>}
                          {peerReaction && <span className="rounded-full bg-slate-800/90 px-1.5 py-0.5 text-[11px] ring-1 ring-slate-700" title={activePeer?.display_name || 'Them'}>{peerReaction}</span>}
                        </div>
                      )}
                      </div>
                    </div>
                  </div>
                )
              })}
              <div ref={messagesEndRef} />
            </div>

            <footer className="border-t border-slate-800 p-3 bg-slate-900/60">
              {recorder.recording && (
                <div className="mb-2 flex items-center gap-3 text-sm text-red-400">
                  <span className="inline-flex h-2.5 w-2.5 rounded-full bg-red-500 animate-pulse" />
                  Recording... {Math.floor(recorder.seconds / 60)}:{String(recorder.seconds % 60).padStart(2, '0')}
                  <button onClick={recorder.cancel} className="ml-auto text-slate-400 hover:text-white inline-flex items-center gap-1"><X size={14} />Cancel</button>
                </div>
              )}
              {pendingAudio && !recorder.recording && (
                <div className="mb-2 flex items-center gap-2 rounded-xl border border-indigo-500/40 bg-slate-950 px-3 py-2">
                  <AudioBubble url={pendingAudio.url} />
                  <button type="button" onClick={clearPendingAudio} className="ml-auto p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800" title="Discard voice note"><X size={16} /></button>
                  <button type="button" onClick={sendPendingAudio} disabled={sendingAudio} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 px-3 py-2 text-sm text-white">
                    <Send size={16} />{sendingAudio ? 'Sending...' : 'Send'}
                  </button>
                </div>
              )}
              {replyTo && (
                <div className="mb-2 flex items-center gap-2 rounded-lg border-l-2 border-indigo-500 bg-slate-950 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-[11px] font-medium text-indigo-400">Replying to {replyTo.sender_id === profile.id ? 'yourself' : (activePeer?.display_name || 'them')}</div>
                    <div className="truncate text-xs text-slate-400">{previewOf(replyTo)}</div>
                  </div>
                  <button type="button" onClick={() => setReplyTo(null)} className="p-1.5 rounded hover:bg-slate-800 text-slate-400 hover:text-white" title="Cancel reply"><X size={14} /></button>
                </div>
              )}
              <form onSubmit={sendText} className="flex items-end gap-2 relative">
                {showEmoji && (
                  <div className="absolute bottom-14 left-0 z-30">
                    <EmojiPicker onEmojiClick={(e) => setText((t) => t + e.emoji)} theme="dark" />
                  </div>
                )}
                <button type="button" onClick={() => setShowEmoji((v) => !v)} className="p-2.5 rounded-lg hover:bg-slate-800 text-slate-300"><Smile size={20} /></button>
                <input type="file" ref={fileInputRef} accept="image/png,image/jpeg,image/webp" className="hidden" onChange={onPickImage} />
                <button type="button" onClick={() => fileInputRef.current?.click()} className="p-2.5 rounded-lg hover:bg-slate-800 text-slate-300" title="Send image"><ImagePlus size={20} /></button>
                <button type="button" onClick={toggleRecord} className={`p-2.5 rounded-lg ${recorder.recording ? 'bg-red-600 text-white' : 'hover:bg-slate-800 text-slate-300'}`} title="Voice message">{recorder.recording ? <Square size={18} /> : <Mic size={20} />}</button>
                <textarea
                  ref={composerRef}
                  value={text}
                  onChange={onTextChange}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(e) } }}
                  placeholder="Type a message"
                  rows={1}
                  className="flex-1 resize-none overflow-y-auto rounded-xl bg-slate-950 border border-slate-700 px-3 py-2.5 outline-none focus:border-indigo-500 max-h-48"
                />
                <button type="submit" disabled={!text.trim()} className="p-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white"><Send size={18} /></button>
              </form>
            </footer>
          </>
        )}
      </section>

      {chatMenu && (
        <div className="fixed inset-0 z-40 flex items-end sm:items-center justify-center bg-black/60 p-4" onClick={() => setChatMenu(null)}>
          <div className="w-full max-w-sm rounded-2xl border border-slate-700 bg-slate-900 p-3" onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 truncate px-1 text-sm font-medium">{chatMenu.peer?.display_name}</div>
            <button type="button" onClick={() => clearChat(chatMenu)} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm hover:bg-slate-800"><Eraser size={16} />Clear chat</button>
            <button type="button" onClick={() => setChatHidden(chatMenu, !chatPrefs[chatMenu.connectionId]?.hidden)} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm hover:bg-slate-800">
              {chatPrefs[chatMenu.connectionId]?.hidden ? <><Eye size={16} />Show chat</> : <><EyeOff size={16} />Hide chat</>}
            </button>
            <button type="button" onClick={() => setChatMenu(null)} className="mt-1 w-full rounded-lg py-2 text-sm text-slate-400 hover:text-white">Cancel</button>
          </div>
        </div>
      )}

      {menuFor && (
        <div className="fixed inset-0 z-40 flex items-end sm:items-center justify-center bg-black/60 p-4" onClick={() => setMenuFor(null)}>
          <div className="w-full max-w-sm max-h-[85vh] overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-3" onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 truncate px-1 text-xs text-slate-400">{previewOf(menuFor)}</div>
            <div className="mb-2 flex items-center justify-between gap-1 rounded-full bg-slate-800 px-2 py-1.5">
              {QUICK_REACTIONS.map((emoji) => (
                <button key={emoji} type="button" onClick={() => react(menuFor, emoji)}
                  className={`h-9 w-9 rounded-full text-xl leading-none hover:bg-slate-700 ${menuFor[`reaction_${profile.id}`] === emoji ? 'bg-slate-700 ring-1 ring-indigo-400' : ''}`}>{emoji}</button>
              ))}
              <button type="button" onClick={() => setShowReactionPicker((v) => !v)}
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full hover:bg-slate-700 ${showReactionPicker ? 'bg-slate-700 text-white' : 'text-slate-300'}`}
                title="Any emoji"><SmilePlus size={18} /></button>
            </div>
            {showReactionPicker && (
              <div className="mb-2 max-h-[45vh] overflow-y-auto rounded-lg">
                <EmojiPicker onEmojiClick={(e) => react(menuFor, e.emoji)} theme="dark" width="100%" height={320} />
              </div>
            )}
            <button type="button" onClick={() => startReply(menuFor)} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm hover:bg-slate-800"><Reply size={16} />Reply</button>
            {menuFor.type === 'text' && (
              <button type="button" onClick={async () => {
                const m = menuFor
                setMenuFor(null)
                try { await navigator.clipboard.writeText(m.content); toast.success('Message copied') }
                catch { toast.error('Could not copy') }
              }} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm hover:bg-slate-800"><Copy size={16} />Copy text</button>
            )}
            <button type="button" onClick={() => { const m = menuFor; setMenuFor(null); setSelectMode(true); setSelected([m.id]) }} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm hover:bg-slate-800"><Check size={16} />Select</button>
            {menuFor.type === 'text' && menuFor.sender_id === profile.id && (
              <button type="button" onClick={() => { const m = menuFor; setMenuFor(null); startEdit(m) }} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm hover:bg-slate-800"><Pencil size={16} />Edit</button>
            )}
            <button type="button" onClick={() => { const m = menuFor; setMenuFor(null); setDeleteTarget(m) }} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-red-400 hover:bg-slate-800"><Trash2 size={16} />Delete</button>
            <button type="button" onClick={() => setMenuFor(null)} className="mt-1 w-full rounded-lg py-2 text-sm text-slate-400 hover:text-white">Cancel</button>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4" onClick={() => setDeleteTarget(null)}>
          <div className="w-full max-w-xs rounded-xl border border-slate-700 bg-slate-900 p-4" onClick={(e) => e.stopPropagation()}>
            <div className="font-medium mb-1">Delete message</div>
            <p className="text-xs text-slate-400 mb-3 truncate">
              {deleteTarget.type === 'text' ? deleteTarget.content : 'This attachment'}
            </p>
            <button type="button" onClick={() => deleteForMe(deleteTarget)} className="w-full rounded-lg bg-slate-800 hover:bg-slate-700 py-2 mb-2 text-sm">Delete for me</button>
            <button type="button" onClick={() => deleteForEveryone(deleteTarget)} className="w-full rounded-lg bg-red-600 hover:bg-red-500 py-2 mb-2 text-sm">Delete for everyone</button>
            <button type="button" onClick={() => setDeleteTarget(null)} className="w-full rounded-lg py-1.5 text-sm text-slate-400 hover:text-white">Cancel</button>
          </div>
        </div>
      )}

      {lightbox && (
        <div className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4" onClick={() => setLightbox(null)}>
          <button className="absolute top-4 right-4 text-white p-2"><X size={28} /></button>
          <img src={lightbox} alt="preview" className="max-w-full max-h-full object-contain" />
        </div>
      )}
    </div>
  )
}


