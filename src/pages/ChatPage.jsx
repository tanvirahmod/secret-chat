import { useEffect, useMemo, useRef, useState } from 'react'
import {
  addDoc, arrayUnion, collection, doc, limit, onSnapshot, orderBy, query, serverTimestamp, setDoc, updateDoc, where, writeBatch, getDocs,
} from 'firebase/firestore'
import EmojiPicker from 'emoji-picker-react'
import imageCompression from 'browser-image-compression'
import { v4 as uuidv4 } from 'uuid'
import {
  Check, CheckCheck, ImagePlus, Menu, Mic, Pause, Pencil, Play, Send, Smile, Square, Trash2, X,
} from 'lucide-react'
import toast from 'react-hot-toast'
import { db } from '../lib/firebase'
import { useAuth } from '../contexts/AuthContext'
import { formatLastSeen, formatTime, isUserOnline } from '../utils/helpers'

const CLOUDINARY_CLOUD_NAME = import.meta.env.VITE_CLOUDINARY_CLOUD_NAME
const CLOUDINARY_UPLOAD_PRESET = import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

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
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => () => {
    if (pendingAudioUrlRef.current) URL.revokeObjectURL(pendingAudioUrlRef.current)
  }, [])

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

  const contacts = useMemo(() => {
    return connections.map((c) => {
      const peerId = c.user_one_id === profile.id ? c.user_two_id : c.user_one_id
      return { connectionId: c.id, peerId, peer: usersById[peerId], connection: c, online: isUserOnline(usersById[peerId], now) }
    }).filter((c) => c.peer && c.peer.role === 'user' && !c.peer.suspended)
      .sort((a, b) => (a.peer.display_name || '').localeCompare(b.peer.display_name || ''))
  }, [connections, usersById, profile?.id, now])

  useEffect(() => {
    if (!profile?.id || contacts.length === 0) { setUnread({}); return }
    const unsubs = contacts.map((c) => {
      const q = query(collection(db, 'messages'), where('connection_id', '==', c.connectionId), where('is_read', '==', false))
      return onSnapshot(q, (snap) => {
        const count = snap.docs.filter((d) => {
          const data = d.data()
          return data.sender_id !== profile.id
            && data.deleted !== true
            && !(data.deleted_for || []).includes(profile.id)
        }).length
        setUnread((prev) => ({ ...prev, [c.connectionId]: count }))
      }, (err) => console.error('unread listener', c.connectionId, err))
    })
    return () => unsubs.forEach((u) => u())
  }, [contacts.map((c) => c.connectionId).join('|'), profile?.id])

  useEffect(() => {
    if (!active?.connectionId) { setMessages([]); return }
    const q = query(collection(db, 'messages'), where('connection_id', '==', active.connectionId), orderBy('created_at', 'asc'), limit(500))
    const unsub = onSnapshot(q, async (snap) => {
      // Removed messages stay on the server: either hidden for one user
      // (`deleted_for`) or for both (`deleted`).
      const msgs = snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .filter((m) => m.deleted !== true && !(m.deleted_for || []).includes(profile.id))
      setMessages(msgs)
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
  }, [active?.connectionId, profile?.id])

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

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

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
    try {
      await addDoc(collection(db, 'messages'), {
        connection_id: active.connectionId,
        sender_id: profile.id,
        type: 'text',
        content,
        is_read: false,
        created_at: serverTimestamp(),
      })
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
      })
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
          {contacts.map((c) => (
            <button key={c.connectionId} onClick={() => { setActive(c); setSidebarOpen(false) }}
              className={`w-full text-left px-4 py-3 border-b border-slate-800/60 hover:bg-slate-800/60 flex items-center gap-3 ${active?.connectionId === c.connectionId ? 'bg-slate-800' : ''}`}>
              <div className="relative">
                <div className="h-10 w-10 rounded-full bg-indigo-700 flex items-center justify-center font-semibold">{(c.peer.display_name || '?')[0].toUpperCase()}</div>
                <span className={`absolute bottom-0 right-0 h-3 w-3 rounded-full border-2 border-slate-900 ${c.online ? 'bg-emerald-400' : 'bg-slate-500'}`} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium truncate">{c.peer.display_name}</span>
                  {unread[c.connectionId] > 0 && <span className="text-xs bg-indigo-600 text-white rounded-full px-2 py-0.5">{unread[c.connectionId]}</span>}
                </div>
                <div className="text-xs text-slate-400 truncate">{c.online ? 'Online' : formatLastSeen(c.peer, now)}</div>
              </div>
            </button>
          ))}
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

            <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-slate-950">
              {messages.map((m) => {
                const mine = m.sender_id === profile.id
                return (
                  <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                    <div className={`group max-w-[85%] sm:max-w-[70%] rounded-2xl px-3 py-2 ${mine ? 'bg-indigo-600 text-white rounded-br-md' : 'bg-slate-800 text-slate-100 rounded-bl-md'}`}>
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
                        <img src={m.content} alt="attachment" className="max-h-72 rounded-lg cursor-pointer object-cover" onClick={() => setLightbox(m.content)} />
                      )}
                      {m.type === 'audio' && <AudioBubble url={m.content} />}
                      <div className={`flex items-center gap-1 mt-1 text-[11px] ${mine ? 'text-indigo-100 justify-end' : 'text-slate-400'}`}>
                        <span>{formatTime(m.created_at)}{m.edited_at ? ' · edited' : ''}</span>
                        {renderReceipt(m)}
                        {m.type === 'text' && mine && (
                          <button type="button" onClick={() => startEdit(m)} className="ml-1 opacity-40 hover:opacity-100 transition-opacity" title="Edit message"><Pencil size={12} /></button>
                        )}
                        <button type="button" onClick={() => setDeleteTarget(m)} className="ml-1 opacity-40 hover:opacity-100 hover:text-red-400 transition-opacity" title="Delete message"><Trash2 size={12} /></button>
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


