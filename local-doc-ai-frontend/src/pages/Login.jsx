// src/pages/Login.jsx
import React, { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import TextField from "../components/TextField.jsx";
import Button from "../components/Button.jsx";

const API_BASE = "http://localhost:3001"; // your local backend

export default function Login() {
  const nav = useNavigate();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const canLogin = useMemo(() => email.trim().length > 0 && password.length >= 4, [email, password]);

  async function onSubmit(e) {
    e.preventDefault();
    setError("");
    setBusy(true);

    try {
        const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
        });

        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
        setError(data?.error || `Login failed (${res.status})`);
        return;
        }

        localStorage.setItem("auth_token", data.token);
        nav("/app", { replace: true });
    } catch (err) {
        setError("Cannot reach the login server. Is the backend running on port 3001?");
    } finally {
        setBusy(false);
    }
    }


  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="mx-auto flex min-h-screen max-w-6xl items-center justify-center px-4">
        <div className="w-full max-w-md">
          <div className="rounded-3xl border border-zinc-200 bg-white p-7 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-2xl bg-zinc-900" />
              <div>
                <div className="text-lg font-semibold text-zinc-900">Sign in</div>
                <div className="text-sm text-zinc-500">Local-only document search UI</div>
              </div>
            </div>

            <form className="mt-6 space-y-4" onSubmit={onSubmit}>
              <TextField
                label="Email"
                value={email}
                onChange={setEmail}
                placeholder="you@company.com"
                autoComplete="email"
              />

              <TextField
                label="Password"
                value={password}
                onChange={setPassword}
                type="password"
                placeholder="Enter your password"
                autoComplete="current-password"
              />

              {error ? (
                <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  {error}
                </div>
              ) : null}

              <Button type="submit" disabled={!canLogin || busy}>
                {busy ? "Signing in..." : "Sign in"}
              </Button>

              <div className="pt-2 text-xs text-zinc-500">
                Backend: <span className="font-medium text-zinc-700">{API_BASE}</span>
              </div>
            </form>
          </div>

          <div className="mt-4 text-center text-xs text-zinc-500">
            No cloud. No external calls. Local auth.
          </div>
        </div>
      </div>
    </div>
  );
}
