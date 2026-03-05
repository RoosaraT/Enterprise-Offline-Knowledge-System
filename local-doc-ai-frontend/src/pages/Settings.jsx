import React, { useEffect, useState } from "react";
import AdminSidebar from "../components/AdminSidebar.jsx";
import Button from "../components/Button.jsx";

export default function Settings() {
  const [orgName, setOrgName] = useState("Enterprise Offline Knowledge System");
  const [defaultUserRole, setDefaultUserRole] = useState("User");
  const [allowRegistrations, setAllowRegistrations] = useState(true);
  const [statusMsg, setStatusMsg] = useState("");
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    async function loadSettings() {
      setErrorMsg("");
      try {
        const token = localStorage.getItem("auth_token");
        const res = await fetch("/api/settings", {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || "Failed to load settings");
        setOrgName(data?.org_name || "Enterprise Offline Knowledge System");
        setDefaultUserRole(data?.default_user_role || "User");
        setAllowRegistrations(Boolean(data?.allow_registrations));
      } catch (err) {
        setErrorMsg(err?.message || "Failed to load settings.");
      }
    }
    loadSettings();
  }, []);

  async function onSave(e) {
    e.preventDefault();
    setStatusMsg("");
    setErrorMsg("");
    try {
      const token = localStorage.getItem("auth_token");
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          org_name: orgName,
          default_user_role: defaultUserRole,
          allow_registrations: allowRegistrations,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Save failed");
      setStatusMsg("Settings saved.");
    } catch (err) {
      setErrorMsg(err?.message || "Save failed.");
    }
  }

  return (
    <div className="min-h-screen w-full bg-zinc-100">
      <div className="flex min-h-screen w-full flex-col md:flex-row">
        <AdminSidebar active="settings" />

        <main className="min-w-0 flex-1 bg-white p-4 md:h-screen md:overflow-auto md:p-6">
          <div className="mb-4">
            <h1 className="text-xl font-semibold text-zinc-900">Settings</h1>
            <p className="text-sm text-zinc-500">Basic configuration for the admin dashboard.</p>
          </div>

          <form onSubmit={onSave} className="max-w-2xl space-y-4 rounded-xl border border-zinc-200 bg-white p-4">
            <label className="block">
              <span className="mb-1 block text-sm text-zinc-600">Organization Name</span>
              <input
                type="text"
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
                className="w-full rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-zinc-400 focus:ring-4 focus:ring-zinc-100"
              />
            </label>

            <label className="block">
              <span className="mb-1 block text-sm text-zinc-600">Default User Role</span>
              <select
                value={defaultUserRole}
                onChange={(e) => setDefaultUserRole(e.target.value)}
                className="w-full rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-zinc-400 focus:ring-4 focus:ring-zinc-100"
              >
                <option>User</option>
                <option>Admin</option>
              </select>
            </label>

            <label className="flex items-center gap-3 rounded-xl border border-zinc-200 px-4 py-3 text-sm text-zinc-700">
              <input
                type="checkbox"
                checked={allowRegistrations}
                onChange={(e) => setAllowRegistrations(e.target.checked)}
                className="h-4 w-4"
              />
              Allow new user registrations
            </label>

            <Button type="submit">Save Settings</Button>

            {statusMsg ? (
              <div className="rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-2 text-sm text-zinc-700">{statusMsg}</div>
            ) : null}
            {errorMsg ? (
              <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{errorMsg}</div>
            ) : null}
          </form>
        </main>
      </div>
    </div>
  );
}
