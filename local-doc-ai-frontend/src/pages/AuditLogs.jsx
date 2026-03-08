import React, { useEffect, useState } from "react";
import AdminSidebar from "../components/AdminSidebar.jsx";
import { apiFetch } from "../lib/auth.js";

function formatDateTime(value) {
  if (!value) return "-";
  const normalized =
    typeof value === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
      ? value.replace(" ", "T") + "Z"
      : value;
  return new Date(normalized).toLocaleString();
}

export default function AuditLogs() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState("");
  const [query, setQuery] = useState("");
  const [actor, setActor] = useState("");
  const [action, setAction] = useState("");

  useEffect(() => {
    async function loadLogs() {
      setLoading(true);
      setErrorMsg("");
      try {
        const params = new URLSearchParams({ limit: "100" });
        if (query.trim()) params.set("q", query.trim());
        if (actor.trim()) params.set("actor", actor.trim());
        if (action.trim()) params.set("action", action.trim());
        const res = await apiFetch(`/api/audit-logs?${params.toString()}`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || "Failed to load audit logs");
        setLogs(data?.logs || []);
      } catch (err) {
        setErrorMsg(err?.message || "Failed to load audit logs.");
      } finally {
        setLoading(false);
      }
    }

    loadLogs();
  }, [query, actor, action]);

  const actionOptions = Array.from(new Set(logs.map((log) => log.action).filter(Boolean))).sort((a, b) => a.localeCompare(b));

  return (
    <div className="min-h-screen w-full bg-zinc-100">
      <div className="flex min-h-screen w-full flex-col md:flex-row">
        <AdminSidebar active="audit-logs" />

        <main className="min-w-0 flex-1 bg-white p-4 md:h-screen md:overflow-auto md:p-6">
          <div className="mb-4">
            <h1 className="text-xl font-semibold text-zinc-900">Audit Logs</h1>
            <p className="text-sm text-zinc-500">Latest authentication, admin, and session activity.</p>
          </div>

          <div className="mb-4 grid gap-3 md:grid-cols-3">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search logs"
              className="w-full rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-zinc-400 focus:ring-4 focus:ring-zinc-100"
            />
            <input
              type="search"
              value={actor}
              onChange={(e) => setActor(e.target.value)}
              placeholder="Filter by actor email"
              className="w-full rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-zinc-400 focus:ring-4 focus:ring-zinc-100"
            />
            <select
              value={action}
              onChange={(e) => setAction(e.target.value)}
              className="w-full rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-zinc-400 focus:ring-4 focus:ring-zinc-100"
            >
              <option value="">All actions</option>
              {actionOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>

          {errorMsg ? (
            <div className="mb-3 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{errorMsg}</div>
          ) : null}

          <div className="overflow-x-auto rounded-xl border border-zinc-200">
            <table className="min-w-full border-collapse text-sm">
              <thead className="bg-zinc-50 text-left">
                <tr>
                  <th className="border-b border-zinc-200 px-4 py-3 font-medium text-zinc-600">Time</th>
                  <th className="border-b border-zinc-200 px-4 py-3 font-medium text-zinc-600">Actor</th>
                  <th className="border-b border-zinc-200 px-4 py-3 font-medium text-zinc-600">Action</th>
                  <th className="border-b border-zinc-200 px-4 py-3 font-medium text-zinc-600">Target</th>
                  <th className="border-b border-zinc-200 px-4 py-3 font-medium text-zinc-600">IP</th>
                  <th className="border-b border-zinc-200 px-4 py-3 font-medium text-zinc-600">Details</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td className="px-4 py-8 text-center text-zinc-500" colSpan={6}>
                      Loading audit logs...
                    </td>
                  </tr>
                ) : logs.length === 0 ? (
                  <tr>
                    <td className="px-4 py-8 text-center text-zinc-500" colSpan={6}>
                      No audit logs yet.
                    </td>
                  </tr>
                ) : (
                  logs.map((log) => (
                    <tr key={log.id} className="align-top hover:bg-zinc-50">
                      <td className="border-b border-zinc-100 px-4 py-3 text-zinc-700">{formatDateTime(log.created_at)}</td>
                      <td className="border-b border-zinc-100 px-4 py-3 text-zinc-700">{log.actor_email || "-"}</td>
                      <td className="border-b border-zinc-100 px-4 py-3 text-zinc-900">{log.action}</td>
                      <td className="border-b border-zinc-100 px-4 py-3 text-zinc-700">
                        {[log.target_type, log.target_id].filter(Boolean).join(": ") || "-"}
                      </td>
                      <td className="border-b border-zinc-100 px-4 py-3 text-zinc-600">{log.ip_address || "-"}</td>
                      <td className="border-b border-zinc-100 px-4 py-3 text-xs text-zinc-600">
                        <pre className="whitespace-pre-wrap break-words font-mono">
                          {log.metadata ? JSON.stringify(log.metadata, null, 2) : "-"}
                        </pre>
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
