// src/pages/Dashboard.jsx
import React, { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import TopBar from "../components/TopBar.jsx";
import Dropzone from "../components/Dropzone.jsx";
import FileList from "../components/FileList.jsx";
import SearchPanel from "../components/SearchPanel.jsx";

export default function Dashboard() {
  const nav = useNavigate();
  const [files, setFiles] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [statusMsg, setStatusMsg] = useState("");

  function onLogout() {
    localStorage.removeItem("auth_token");
    nav("/login", { replace: true });
  }

  function getTokenOrThrow() {
    const token = localStorage.getItem("auth_token");
    if (!token) throw new Error("Missing auth token. Please log in again.");
    return token;
  }

  async function uploadToBackend(newFiles) {
    const token = getTokenOrThrow();

    const fd = new FormData();
    for (const f of newFiles) fd.append("files", f);

    const res = await fetch("/api/upload", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: fd,
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || `Upload failed (${res.status})`);
    return data;
  }

  async function clearSession() {
    setUploadError("");
    setStatusMsg("");

    try {
      const token = getTokenOrThrow();

      const res = await fetch("/api/session/clear", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `Clear failed (${res.status})`);

      setFiles([]);
      setStatusMsg("Session cleared. Upload files again.");
    } catch (e) {
      setUploadError(e?.message || "Failed to clear session");
    }
  }

  async function addFiles(newFiles) {
    setUploadError("");
    setStatusMsg("");

    // avoid duplicates by name+size (simple)
    const unique = [];
    setFiles((prev) => {
      const existing = new Set(prev.map((f) => `${f.name}::${f.size}`));
      const merged = [...prev];

      for (const f of newFiles) {
        const key = `${f.name}::${f.size}`;
        if (!existing.has(key)) {
          existing.add(key);
          merged.push(f);
          unique.push(f);
        }
      }
      return merged;
    });

    // send only unique files to backend
    if (unique.length === 0) {
      setStatusMsg("No new files to upload.");
      return;
    }

    try {
      setUploading(true);
      setStatusMsg("Uploading and indexing… (PDFs may take longer)");
      await uploadToBackend(unique);
      setStatusMsg("Upload complete.");
    } catch (e) {
      setUploadError(e?.message || "Upload failed");
      setStatusMsg("");
    } finally {
      setUploading(false);
    }
  }

  function removeFile(index) {
    // UI only. Backend delete can be added later.
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  const stats = useMemo(() => {
    const totalBytes = files.reduce((acc, f) => acc + (f.size || 0), 0);
    return { count: files.length, totalBytes };
  }, [files]);

  function formatBytes(bytes) {
    if (!bytes || bytes < 1) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    let v = bytes;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  return (
    <div className="min-h-screen bg-zinc-50">
      <TopBar onLogout={onLogout} />

      <div className="mx-auto max-w-6xl px-4 py-6">
        <div className="mb-6">
          <div className="text-xl font-semibold text-zinc-900">Workspace</div>
          <div className="mt-1 text-sm text-zinc-500">
            Upload files and search for exact text or meaning. Everything stays local.
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <div className="inline-flex items-center gap-2 rounded-2xl border border-zinc-200 bg-white px-4 py-2 text-xs text-zinc-600">
              <span>{stats.count} files</span>
              <span className="text-zinc-300">•</span>
              <span>{formatBytes(stats.totalBytes)}</span>
              <span className="text-zinc-300">•</span>
              <span>Local session</span>
            </div>

            <button
              type="button"
              onClick={clearSession}
              className="rounded-2xl border border-zinc-200 bg-white px-4 py-2 text-xs text-zinc-700 hover:bg-zinc-50"
            >
              Clear session
            </button>

            {uploading ? (
              <div className="rounded-2xl border border-zinc-200 bg-white px-4 py-2 text-xs text-zinc-600">
                Uploading…
              </div>
            ) : null}

            {statusMsg ? (
              <div className="rounded-2xl border border-zinc-200 bg-white px-4 py-2 text-xs text-zinc-700">
                {statusMsg}
              </div>
            ) : null}

            {uploadError ? (
              <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700">
                {uploadError}
              </div>
            ) : null}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div className="space-y-6">
            <Dropzone onFiles={addFiles} />
            <FileList files={files} onRemove={removeFile} />
          </div>

          <div className="space-y-6">
            <SearchPanel files={files} />
            <div className="rounded-2xl border border-zinc-200 bg-white p-5">
              <div className="text-sm font-semibold text-zinc-900">Note</div>
              <div className="mt-1 text-sm text-zinc-600">
                Exact search is fast. Context (AI) uses local models and can take longer, especially after uploading PDFs.
              </div>
            </div>
          </div>
        </div>

        <div className="mt-10 text-xs text-zinc-500">
          Tip: keep everything local (localhost / LAN). No cloud needed.
        </div>
      </div>
    </div>
  );
}
