import React, { useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import Login from "./pages/Login.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import Register from "./pages/Register.jsx";
import Users from "./pages/Users.jsx";
import Settings from "./pages/Settings.jsx";
import UserChat from "./pages/UserChat.jsx";
import AuditLogs from "./pages/AuditLogs.jsx";
import { apiFetch, cacheCurrentUser, clearClientSession, getCachedUser } from "./lib/auth.js";

function ProtectedRoute({ children, requiredRole }) {
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState(() => getCachedUser());

  useEffect(() => {
    let alive = true;

    async function verifySession() {
      try {
        const res = await apiFetch("/api/me");
        if (!alive) return;
        if (!res.ok) {
          clearClientSession();
          setUser(null);
          return;
        }

        const data = await res.json().catch(() => null);
        setUser(data || null);
        cacheCurrentUser(data || null);
      } catch {
        clearClientSession();
        setUser(null);
      } finally {
        if (alive) setLoading(false);
      }
    }

    verifySession();
    return () => {
      alive = false;
    };
  }, []);

  if (loading) return <div className="min-h-screen bg-zinc-50" />;
  if (!user) return <Navigate to="/login" replace />;
  if (requiredRole && user.role !== requiredRole) {
    return <Navigate to={user.role === "Admin" ? "/app" : "/chat"} replace />;
  }
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/login" replace />} />
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route
        path="/app"
        element={
          <ProtectedRoute requiredRole="Admin">
            <Dashboard />
          </ProtectedRoute>
        }
      />
      <Route
        path="/users"
        element={
          <ProtectedRoute requiredRole="Admin">
            <Users />
          </ProtectedRoute>
        }
      />
      <Route
        path="/settings"
        element={
          <ProtectedRoute requiredRole="Admin">
            <Settings />
          </ProtectedRoute>
        }
      />
      <Route
        path="/audit-logs"
        element={
          <ProtectedRoute requiredRole="Admin">
            <AuditLogs />
          </ProtectedRoute>
        }
      />
      <Route
        path="/chat"
        element={
          <ProtectedRoute requiredRole="User">
            <UserChat />
          </ProtectedRoute>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
