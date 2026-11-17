import { useEffect, useMemo, useState } from "react";
import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";
import { createUserWithEmailAndPassword, getAuth, signOut as signOutSecondary } from "firebase/auth";
import { initializeApp, deleteApp } from "firebase/app";
import { Copy, Link2, LogOut, RefreshCw, Shield, Trash2, Unlink, UserPlus, Wand2 } from "lucide-react";
import toast from "react-hot-toast";
import { db, app } from "../lib/firebase";
import { useAuth } from "../contexts/AuthContext";
import { connectionIdFor, generatePassword, usernameToEmail } from "../utils/helpers";

function useSecondaryAuth() {
  async function createAuthUser(username, password) {
    const secondary = initializeApp(app.options, `secondary-${Date.now()}`);
    try {
      const secondaryAuth = getAuth(secondary);
      const email = usernameToEmail(username);
      const cred = await createUserWithEmailAndPassword(secondaryAuth, email, password);
      await signOutSecondary(secondaryAuth);
      return cred.user.uid;
    } finally {
      await deleteApp(secondary).catch(() => {});
    }
  }
  return { createAuthUser };
}

export default function AdminPage() {
  const { logout, profile } = useAuth();
  const { createAuthUser } = useSecondaryAuth();
  const [users, setUsers] = useState([]);
  const [connections, setConnections] = useState([]);
  const [form, setForm] = useState({ displayName: "", username: "", password: "" });
  const [pair, setPair] = useState({ a: "", b: "" });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const unsubUsers = onSnapshot(query(collection(db, "users"), where("role", "==", "user")), (snap) => {
      setUsers(
        snap.docs
          .map((d) => ({ id: d.id, ...d.data() }))
          .sort((a, b) => (a.display_name || "").localeCompare(b.display_name || ""))
      );
    });
    const unsubConn = onSnapshot(collection(db, "connections"), (snap) => {
      setConnections(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
    return () => {
      unsubUsers();
      unsubConn();
    };
  }, []);

  const userMap = useMemo(() => Object.fromEntries(users.map((u) => [u.id, u])), [users]);

  async function createUser(e) {
    e.preventDefault();
    const displayName = form.displayName.trim();
    const username = form.username.trim().toLowerCase();
    const password = form.password;
    if (!displayName || !username || password.length < 6) {
      return toast.error("Provide name, username, and password (6+ chars).");
    }
    if (users.some((u) => u.username === username)) return toast.error("Username already exists.");
    setBusy(true);
    try {
      const uid = await createAuthUser(username, password);
      await setDoc(doc(db, "users", uid), {
        username,
        display_name: displayName,
        role: "user",
        suspended: false,
        is_online: false,
        last_seen: serverTimestamp(),
        created_at: serverTimestamp(),
      });
      toast.success(`User ${username} created`);
      setForm({ displayName: "", username: "", password: "" });
    } catch (err) {
      console.error(err);
      toast.error(err.message || "Failed to create user");
    } finally {
      setBusy(false);
    }
  }

  async function resetPassword(user) {
    const newPass = generatePassword(12);
    const ok = window.confirm(
      `Generate a new password for ${user.username}? You must also update it in Firebase Auth manually if not using Admin SDK; this app stores credentials in Auth only. For client-side reset without Admin SDK, delete & recreate the user, or use Firebase Console.`
    );
    if (!ok) return;
    try {
      await navigator.clipboard.writeText(newPass);
      toast.success(`Generated password copied: ${newPass} - apply it via Firebase Console/Auth for this user.`);
    } catch {
      toast(`Generated: ${newPass}`, { duration: 10000 });
    }
  }

  async function toggleSuspend(user) {
    try {
      await updateDoc(doc(db, "users", user.id), { suspended: !user.suspended, is_online: false });
      toast.success(user.suspended ? "User restored" : "User suspended");
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function removeUser(user) {
    if (
      !window.confirm(
        `Delete ${user.username}? This removes their profile and connections (Auth account must be removed in Firebase Console/Admin).`
      )
    )
      return;
    try {
      const qs = await getDocs(collection(db, "connections"));
      const toDelete = qs.docs.filter((d) => d.data().user_one_id === user.id || d.data().user_two_id === user.id);
      await Promise.all(toDelete.map((d) => deleteDoc(d.ref)));
      await deleteDoc(doc(db, "users", user.id));
      toast.success("User profile and connections removed");
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function copyCreds(user) {
    const text = `Username: ${user.username}\nDisplay Name: ${user.display_name || ""}`;
    await navigator.clipboard.writeText(text).catch(() => {});
    toast.success("User info copied (password is not stored in plaintext).");
  }

  async function connectUsers(e) {
    e.preventDefault();
    if (!pair.a || !pair.b || pair.a === pair.b) return toast.error("Select two different users.");
    const id = connectionIdFor(pair.a, pair.b);
    if (connections.some((c) => c.id === id)) return toast.error("Connection already exists.");
    try {
      const [one, two] = [pair.a, pair.b].sort();
      await setDoc(doc(db, "connections", id), {
        user_one_id: one,
        user_two_id: two,
        created_at: serverTimestamp(),
      });
      toast.success("Users connected");
      setPair({ a: "", b: "" });
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function disconnect(id) {
    if (!window.confirm("Revoke this connection?")) return;
    try {
      await deleteDoc(doc(db, "connections", id));
      toast.success("Connection revoked");
    } catch (err) {
      toast.error(err.message);
    }
  }

  return (
    <div className="min-h-full bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 px-4 sm:px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-lg bg-indigo-600 flex items-center justify-center">
            <Shield size={18} />
          </div>
          <div>
            <h1 className="font-semibold">Controller Dashboard</h1>
            <p className="text-xs text-slate-400">Signed in as {profile?.display_name || profile?.username}</p>
          </div>
        </div>
        <button onClick={logout} className="inline-flex items-center gap-2 text-sm px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700">
          <LogOut size={16} />Logout
        </button>
      </header>

      <main className="max-w-7xl mx-auto p-4 sm:p-6 grid lg:grid-cols-2 gap-6">
        <section className="bg-slate-900 border border-slate-800 rounded-xl p-5">
          <h2 className="font-semibold mb-4 flex items-center gap-2">
            <UserPlus size={18} /> Create User
          </h2>
          <form onSubmit={createUser} className="space-y-3">
            <input
              className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 outline-none focus:border-indigo-500"
              placeholder="Display Name"
              value={form.displayName}
              onChange={(e) => setForm({ ...form, displayName: e.target.value })}
            />
            <input
              className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 outline-none focus:border-indigo-500"
              placeholder="Login ID / Username"
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
            />
            <div className="flex gap-2">
              <input
                className="flex-1 rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 outline-none focus:border-indigo-500"
                placeholder="Password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
              />
              <button
                type="button"
                onClick={() => setForm((f) => ({ ...f, password: generatePassword(12) }))}
                className="px-3 rounded-lg bg-slate-800 hover:bg-slate-700 inline-flex items-center gap-1 text-sm"
              >
                <Wand2 size={16} />Generate
              </button>
            </div>
            <button disabled={busy} className="w-full rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 py-2 font-medium">
              {busy ? "Creating..." : "Create User"}
            </button>
          </form>
          <p className="text-xs text-slate-500 mt-3">Share the username and password securely with the user. Passwords are not stored in Firestore.</p>
        </section>

        <section className="bg-slate-900 border border-slate-800 rounded-xl p-5">
          <h2 className="font-semibold mb-4 flex items-center gap-2">
            <Link2 size={18} /> Pair Users (Connection Matrix)
          </h2>
          <form onSubmit={connectUsers} className="flex flex-col sm:flex-row gap-2 mb-4">
            <select className="flex-1 rounded-lg bg-slate-950 border border-slate-700 px-3 py-2" value={pair.a} onChange={(e) => setPair({ ...pair, a: e.target.value })}>
              <option value="">Select User A</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.display_name} (@{u.username})
                </option>
              ))}
            </select>
            <select className="flex-1 rounded-lg bg-slate-950 border border-slate-700 px-3 py-2" value={pair.b} onChange={(e) => setPair({ ...pair, b: e.target.value })}>
              <option value="">Select User B</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.display_name} (@{u.username})
                </option>
              ))}
            </select>
            <button className="rounded-lg bg-emerald-600 hover:bg-emerald-500 px-4 py-2 font-medium">Connect</button>
          </form>
          <div className="space-y-2 max-h-64 overflow-auto pr-1">
            {connections.length === 0 && <p className="text-sm text-slate-500">No active connections.</p>}
            {connections.map((c) => (
              <div key={c.id} className="flex items-center justify-between bg-slate-950 border border-slate-800 rounded-lg px-3 py-2">
                <span className="text-sm">
                  {userMap[c.user_one_id]?.display_name || c.user_one_id} <span className="text-slate-500">&lt;-&gt;</span> {userMap[c.user_two_id]?.display_name || c.user_two_id}
                </span>
                <button onClick={() => disconnect(c.id)} className="text-red-400 hover:text-red-300 inline-flex items-center gap-1 text-sm">
                  <Unlink size={14} />Revoke
                </button>
              </div>
            ))}
          </div>
        </section>

        <section className="lg:col-span-2 bg-slate-900 border border-slate-800 rounded-xl p-5">
          <h2 className="font-semibold mb-4">All Users</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-slate-400 border-b border-slate-800">
                <tr>
                  <th className="py-2 pr-3">Display Name</th>
                  <th className="py-2 pr-3">Username</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className="border-b border-slate-800/60">
                    <td className="py-2 pr-3">{u.display_name}</td>
                    <td className="py-2 pr-3 font-mono text-slate-300">@{u.username}</td>
                    <td className="py-2 pr-3">
                      <span className={`inline-flex items-center gap-1 ${u.suspended ? "text-amber-400" : "text-emerald-400"}`}>
                        <span className={`h-2 w-2 rounded-full ${u.suspended ? "bg-amber-400" : "bg-emerald-400"}`} />
                        {u.suspended ? "Suspended" : "Active"}
                      </span>
                    </td>
                    <td className="py-2">
                      <div className="flex flex-wrap gap-2">
                        <button onClick={() => copyCreds(u)} className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 inline-flex items-center gap-1">
                          <Copy size={14} />Copy
                        </button>
                        <button onClick={() => resetPassword(u)} className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 inline-flex items-center gap-1">
                          <RefreshCw size={14} />Reset PW
                        </button>
                        <button onClick={() => toggleSuspend(u)} className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700">
                          {u.suspended ? "Restore" : "Suspend"}
                        </button>
                        <button onClick={() => removeUser(u)} className="px-2 py-1 rounded bg-red-900/40 hover:bg-red-900/60 text-red-300 inline-flex items-center gap-1">
                          <Trash2 size={14} />Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {users.length === 0 && (
                  <tr>
                    <td colSpan="4" className="py-6 text-center text-slate-500">
                      No users yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}
