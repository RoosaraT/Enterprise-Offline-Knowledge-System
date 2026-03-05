import React, { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import TextField from "../components/TextField.jsx";
import Button from "../components/Button.jsx";

function toBackendEmail(username) {
  const trimmed = username.trim();
  if (trimmed.includes("@")) return trimmed;
  return `${trimmed}@local`;
}

export default function Register() {
  const nav = useNavigate();

  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const canSubmit = useMemo(() => {
    return (
      name.trim().length > 1 &&
      username.trim().length > 2 &&
      password.length >= 6 &&
      confirmPassword.length >= 6
    );
  }, [name, username, password, confirmPassword]);

  async function onSubmit(e) {
    e.preventDefault();
    setError("");
    setSuccess("");

    if (password !== confirmPassword) {
      setError("Password and confirm password must match.");
      return;
    }

    setBusy(true);
    try {
      const email = toBackendEmail(username);
      const res = await fetch("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          password,
          name,
          username
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error || `Registration failed (${res.status})`);
        return;
      }

      setSuccess("Registration successful. You can sign in now.");
      setTimeout(() => nav("/login"), 600);
    } catch (err) {
      setError("Cannot reach the backend. Is it running on port 3001?");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="mx-auto flex min-h-screen max-w-6xl items-center justify-center px-4 py-8">
        <div className="w-full max-w-md">
          <div className="rounded-3xl border border-zinc-200 bg-white p-7 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-2xl bg-zinc-900" />
              <div>
                <div className="text-lg font-semibold text-zinc-900">Create account</div>
                <div className="text-sm text-zinc-500">Set up local access</div>
              </div>
            </div>

            <form className="mt-6 space-y-4" onSubmit={onSubmit}>
              <TextField label="Name" value={name} onChange={setName} placeholder="Your full name" autoComplete="name" />

              <TextField
                label="Username"
                value={username}
                onChange={setUsername}
                placeholder="username or email"
                autoComplete="username"
              />

              <TextField
                label="Password"
                value={password}
                onChange={setPassword}
                type="password"
                placeholder="At least 6 characters"
                autoComplete="new-password"
              />

              <TextField
                label="Confirm Password"
                value={confirmPassword}
                onChange={setConfirmPassword}
                type="password"
                placeholder="Re-enter your password"
                autoComplete="new-password"
              />
              {error ? (
                <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
              ) : null}

              {success ? (
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
                  {success}
                </div>
              ) : null}

              <Button type="submit" disabled={!canSubmit || busy}>
                {busy ? "Creating account..." : "Register"}
              </Button>

              <div className="text-sm text-zinc-600">
                Already have an account?{" "}
                <Link to="/login" className="font-medium text-zinc-900 underline underline-offset-2">
                  Sign in
                </Link>
              </div>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
