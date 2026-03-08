import React, { useEffect, useMemo, useState } from "react";
import AdminSidebar from "../components/AdminSidebar.jsx";
import Button from "../components/Button.jsx";
import { apiFetch } from "../lib/auth.js";

function formatDate(value) {
  return new Date(value).toLocaleDateString();
}

function isBuiltInAdmin(user) {
  return String(user?.email || "").trim().toLowerCase() === "admin@company.com";
}

export default function Users() {
  const [users, setUsers] = useState([]);
  const [statusMsg, setStatusMsg] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({
    name: "",
    username: "",
    email: "",
    role: "User",
    status: "Active",
    password: "",
  });

  useEffect(() => {
    async function loadUsers() {
      setLoading(true);
      setErrorMsg("");
      try {
        const res = await apiFetch("/api/users");
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setErrorMsg(data?.error || "Failed to load users.");
          return;
        }
        setUsers(data?.users || []);
      } catch (err) {
        setErrorMsg("Server not reachable.");
      } finally {
        setLoading(false);
      }
    }
    loadUsers();
  }, []);

  const sortedUsers = useMemo(() => {
    return [...users].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }, [users]);

  async function onEditUser(user) {
    setStatusMsg("");
    setErrorMsg("");
    const nextRole = user.role === "Admin" ? "User" : "Admin";
    try {
      const res = await apiFetch(`/api/users/${user.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ role: nextRole }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Update failed");
      setUsers((prev) => prev.map((u) => (u.id === user.id ? { ...u, role: nextRole } : u)));
      setStatusMsg("User updated.");
    } catch (err) {
      setErrorMsg(err?.message || "Update failed.");
    }
  }

  async function onToggleStatus(user) {
    setStatusMsg("");
    setErrorMsg("");
    const nextStatus = user.status === "Active" ? "Suspended" : "Active";
    try {
      const res = await apiFetch(`/api/users/${user.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ status: nextStatus }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Update failed");
      setUsers((prev) => prev.map((u) => (u.id === user.id ? { ...u, status: nextStatus } : u)));
      setStatusMsg("User status updated.");
    } catch (err) {
      setErrorMsg(err?.message || "Update failed.");
    }
  }

  async function onDeleteUser(user) {
    setStatusMsg("");
    setErrorMsg("");
    try {
      const res = await apiFetch(`/api/users/${user.id}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Delete failed");
      setUsers((prev) => prev.filter((u) => u.id !== user.id));
      setStatusMsg("User deleted.");
    } catch (err) {
      setErrorMsg(err?.message || "Delete failed.");
    }
  }

  async function onForceLogout(user) {
    setStatusMsg("");
    setErrorMsg("");
    const confirmed = window.confirm(`Log out all active sessions for ${user.email}? The user can sign in again immediately.`);
    if (!confirmed) return;
    try {
      const res = await apiFetch(`/api/users/${user.id}/revoke-sessions`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Force logout failed");
      setStatusMsg(`Logged out active sessions for ${user.email}.`);
    } catch (err) {
      setErrorMsg(err?.message || "Force logout failed.");
    }
  }

  async function onCreateUser(e) {
    e.preventDefault();
    setStatusMsg("");
    setErrorMsg("");
    try {
      const res = await apiFetch("/api/users", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(createForm),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Create failed");
      setUsers((prev) => [data.user, ...prev]);
      setCreateForm({ name: "", username: "", email: "", role: "User", status: "Active", password: "" });
      setShowCreate(false);
      setStatusMsg("User created.");
    } catch (err) {
      setErrorMsg(err?.message || "Create failed.");
    }
  }

  return (
    <div className="min-h-screen w-full bg-zinc-100">
      <div className="flex min-h-screen w-full flex-col md:flex-row">
        <AdminSidebar active="users" />

        <main className="min-w-0 flex-1 bg-white p-4 md:h-screen md:overflow-auto md:p-6">
          <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <h1 className="text-xl font-semibold text-zinc-900">User Management</h1>
              <p className="text-sm text-zinc-500">Manage access, roles, and account status.</p>
            </div>
            <Button onClick={() => setShowCreate((v) => !v)}>
              {showCreate ? "Cancel" : "Create User"}
            </Button>
          </div>

          {showCreate ? (
            <form onSubmit={onCreateUser} className="mb-4 grid gap-3 rounded-xl border border-zinc-200 bg-white p-4 md:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-sm text-zinc-600">Name</span>
                <input
                  type="text"
                  value={createForm.name}
                  onChange={(e) => setCreateForm((p) => ({ ...p, name: e.target.value }))}
                  className="w-full rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-zinc-400 focus:ring-4 focus:ring-zinc-100"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-sm text-zinc-600">Username</span>
                <input
                  type="text"
                  value={createForm.username}
                  onChange={(e) => setCreateForm((p) => ({ ...p, username: e.target.value }))}
                  className="w-full rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-zinc-400 focus:ring-4 focus:ring-zinc-100"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-sm text-zinc-600">Email</span>
                <input
                  type="email"
                  value={createForm.email}
                  onChange={(e) => setCreateForm((p) => ({ ...p, email: e.target.value }))}
                  className="w-full rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-zinc-400 focus:ring-4 focus:ring-zinc-100"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-sm text-zinc-600">Password</span>
                <input
                  type="password"
                  value={createForm.password}
                  onChange={(e) => setCreateForm((p) => ({ ...p, password: e.target.value }))}
                  className="w-full rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-zinc-400 focus:ring-4 focus:ring-zinc-100"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-sm text-zinc-600">Role</span>
                <select
                  value={createForm.role}
                  onChange={(e) => setCreateForm((p) => ({ ...p, role: e.target.value }))}
                  className="w-full rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-zinc-400 focus:ring-4 focus:ring-zinc-100"
                >
                  <option>User</option>
                  <option>Admin</option>
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-sm text-zinc-600">Status</span>
                <select
                  value={createForm.status}
                  onChange={(e) => setCreateForm((p) => ({ ...p, status: e.target.value }))}
                  className="w-full rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-zinc-400 focus:ring-4 focus:ring-zinc-100"
                >
                  <option>Active</option>
                  <option>Suspended</option>
                </select>
              </label>
              <div className="md:col-span-2 flex justify-end">
                <Button type="submit">Create</Button>
              </div>
            </form>
          ) : null}

          {statusMsg ? (
            <div className="mb-3 rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-2 text-sm text-zinc-700">{statusMsg}</div>
          ) : null}
          {errorMsg ? (
            <div className="mb-3 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{errorMsg}</div>
          ) : null}

          <div className="overflow-x-auto rounded-xl border border-zinc-200">
            <table className="min-w-full border-collapse text-sm">
              <thead className="bg-zinc-50 text-left">
                <tr>
                  <th className="border-b border-zinc-200 px-4 py-3 font-medium text-zinc-600">Name</th>
                  <th className="border-b border-zinc-200 px-4 py-3 font-medium text-zinc-600">Email</th>
                  <th className="border-b border-zinc-200 px-4 py-3 font-medium text-zinc-600">Role</th>
                  <th className="border-b border-zinc-200 px-4 py-3 font-medium text-zinc-600">Registered date</th>
                  <th className="border-b border-zinc-200 px-4 py-3 font-medium text-zinc-600">Status</th>
                  <th className="border-b border-zinc-200 px-4 py-3 font-medium text-zinc-600">Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td className="px-4 py-8 text-center text-zinc-500" colSpan={6}>
                      Loading users...
                    </td>
                  </tr>
                ) : sortedUsers.length === 0 ? (
                  <tr>
                    <td className="px-4 py-8 text-center text-zinc-500" colSpan={6}>
                      No users found.
                    </td>
                  </tr>
                ) : (
                  sortedUsers.map((user) => (
                    <tr key={user.id} className="hover:bg-zinc-50">
                      <td className="border-b border-zinc-100 px-4 py-3 text-zinc-800">{user.name || user.username || "—"}</td>
                      <td className="border-b border-zinc-100 px-4 py-3 text-zinc-600">{user.email}</td>
                      <td className="border-b border-zinc-100 px-4 py-3 text-zinc-600">{user.role}</td>
                      <td className="border-b border-zinc-100 px-4 py-3 text-zinc-600">{formatDate(user.created_at)}</td>
                      <td className="border-b border-zinc-100 px-4 py-3">
                        <span
                          className={`rounded-full px-2 py-1 text-xs font-medium ${
                            user.status === "Active" ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"
                          }`}
                        >
                          {user.status}
                        </span>
                      </td>
                      <td className="border-b border-zinc-100 px-4 py-3">
                        <div className="flex flex-wrap gap-2">
                          {isBuiltInAdmin(user) ? (
                            <span className="rounded-lg border border-zinc-200 px-2 py-1 text-xs text-zinc-500">
                              Protected admin account
                            </span>
                          ) : (
                            <>
                              <button
                                type="button"
                                onClick={() => onEditUser(user)}
                                className="rounded-lg border border-zinc-200 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-100"
                              >
                                Switch Role
                              </button>
                              <button
                                type="button"
                                onClick={() => onToggleStatus(user)}
                                className="rounded-lg border border-zinc-200 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-100"
                              >
                                Change Status
                              </button>
                              <button
                                type="button"
                                onClick={() => onDeleteUser(user)}
                                className="rounded-lg border border-red-200 px-2 py-1 text-xs text-red-700 hover:bg-red-50"
                              >
                                Delete
                              </button>
                            </>
                          )}
                          <button
                            type="button"
                            onClick={() => onForceLogout(user)}
                            className="rounded-lg border border-zinc-200 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-100"
                          >
                            Log Out Sessions
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </main>
      </div>
    </div>
  );
}
