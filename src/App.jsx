import { Navigate, Route, Routes } from 'react-router-dom'
import { useAuth } from './contexts/AuthContext'
import LoginPage from './pages/LoginPage'
import AdminPage from './pages/AdminPage'
import ChatPage from './pages/ChatPage'

function ProtectedRoute({ children, role }) {
  const { firebaseUser, profile, loading } = useAuth()
  if (loading) return <div className="h-full flex items-center justify-center text-gray-500">Loading...</div>
  if (!firebaseUser || !profile) return <Navigate to="/login" replace />
  if (profile.suspended) return <Navigate to="/login" replace />
  if (role && profile.role !== role) {
    return <Navigate to={profile.role === 'admin' ? '/admin' : '/chat'} replace />
  }
  return children
}

function HomeRedirect() {
  const { firebaseUser, profile, loading } = useAuth()
  if (loading) return <div className="h-full flex items-center justify-center text-gray-500">Loading...</div>
  if (!firebaseUser || !profile) return <Navigate to="/login" replace />
  return <Navigate to={profile.role === 'admin' ? '/admin' : '/chat'} replace />
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<HomeRedirect />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/admin" element={<ProtectedRoute role="admin"><AdminPage /></ProtectedRoute>} />
      <Route path="/chat" element={<ProtectedRoute role="user"><ChatPage /></ProtectedRoute>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
