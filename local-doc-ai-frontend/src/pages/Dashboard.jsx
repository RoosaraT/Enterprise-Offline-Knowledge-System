// src/pages/Dashboard.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import Button from "../components/Button.jsx";
import AdminSidebar from "../components/AdminSidebar.jsx";

function formatBytes(bytes) {
  if (!bytes || bytes < 1) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function typeFromName(name) {
  const ext = name.split(".").pop()?.toLowerCase();
  if (!ext || ext === name.toLowerCase()) return "File";
  return ext.toUpperCase();
}

function formatDate(value) {
  return new Date(value).toLocaleDateString();
}

export default function Dashboard() {
  const fileInputRef = useRef(null);

  const [documents, setDocuments] = useState([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusMsg, setStatusMsg] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [uploading, setUploading] = useState(false);

  function getTokenOrThrow() {
    const token = localStorage.getItem("auth_token");
    if (!token) throw new Error("Missing auth token. Please log in again.");
    return token;
  }

  async function uploadToBackend(files) {
    const token = getTokenOrThrow();
    const formData = new FormData();
    for (const file of files) formData.append("files", file);

    const res = await fetch("/api/upload", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || `Upload failed (${res.status})`);
    return data;
  }

  async function loadDocuments() {
    setErrorMsg("");
    try {
      const token = getTokenOrThrow();
      const res = await fetch("/api/files", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `Load failed (${res.status})`);

      const mapped = (data?.files || []).map((row) => ({
        id: `db-${row.id}`,
        name: row.original_name,
        type: typeFromName(row.original_name),
        date: row.uploaded_at,
        size: row.size_bytes || 0,
        status: "Indexed",
      }));
      setDocuments(mapped);
    } catch (err) {
      setErrorMsg(err?.message || "Failed to load documents");
    }
  }

  useEffect(() => {
    loadDocuments();
  }, []);

  async function onUploadSelected(fileList) {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;

    setErrorMsg("");
    setStatusMsg("");

    const now = Date.now();
    const incomingDocs = files.map((file, idx) => ({
      id: `${file.name}-${file.size}-${now}-${idx}`,
      name: file.name,
      type: typeFromName(file.name),
      date: new Date().toISOString(),
      size: file.size || 0,
      status: "Indexing",
    }));

    setDocuments((prev) => {
      const existing = new Set(prev.map((d) => `${d.name}::${d.size}`));
      const unique = incomingDocs.filter((d) => !existing.has(`${d.name}::${d.size}`));
      return [...unique, ...prev];
    });

    try {
      setUploading(true);
      setStatusMsg("Uploading and indexing documents...");
      await uploadToBackend(files);
      setDocuments((prev) => prev.map((d) => (incomingDocs.some((n) => n.id === d.id) ? { ...d, status: "Indexed" } : d)));
      setStatusMsg("Upload complete.");
    } catch (err) {
      setDocuments((prev) =>
        prev.map((d) => (incomingDocs.some((n) => n.id === d.id) ? { ...d, status: "Upload failed" } : d)),
      );
      setErrorMsg(err?.message || "Upload failed");
      setStatusMsg("");
    } finally {
      setUploading(false);
    }
  }

  function onDeleteDocument(id) {
    setDocuments((prev) => prev.filter((d) => d.id !== id));
  }

  function onEditDocument(id) {
    setDocuments((prev) => prev.map((d) => (d.id === id ? { ...d, name: `${d.name} (edited)` } : d)));
    setStatusMsg("Document label updated.");
  }

  function onViewDocument(doc) {
    setStatusMsg(`Viewing "${doc.name}" is not wired yet.`);
  }

  function onReindexDocument(id) {
    setDocuments((prev) => prev.map((d) => (d.id === id ? { ...d, status: "Indexing" } : d)));
    setTimeout(() => {
      setDocuments((prev) => prev.map((d) => (d.id === id ? { ...d, status: "Indexed" } : d)));
      setStatusMsg("Re-index complete.");
    }, 700);
  }

  const filteredDocuments = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return documents;
    return documents.filter(
      (doc) =>
        doc.name.toLowerCase().includes(q) ||
        doc.type.toLowerCase().includes(q) ||
        doc.status.toLowerCase().includes(q),
    );
  }, [documents, searchQuery]);

  return (
    <div className="min-h-screen w-full bg-zinc-100">
      <div className="flex min-h-screen w-full flex-col md:flex-row">
        <AdminSidebar active="documents" />

        <main className="min-w-0 flex-1 bg-white p-4 md:h-screen md:overflow-auto md:p-6">
          <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <h1 className="text-xl font-semibold text-zinc-900">Documents</h1>
              <p className="text-sm text-zinc-500">Manage uploaded documents and indexing state.</p>
            </div>
          </div>

          <div className="mb-4 flex flex-col gap-3 md:flex-row">
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search documents"
              className="w-full rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-zinc-400 focus:ring-4 focus:ring-zinc-100"
            />

            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                onUploadSelected(e.target.files);
                e.target.value = "";
              }}
            />

            <Button onClick={() => fileInputRef.current?.click()} disabled={uploading}>
              {uploading ? "Uploading..." : "Upload"}
            </Button>
          </div>

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
                  <th className="border-b border-zinc-200 px-4 py-3 font-medium text-zinc-600">Type</th>
                  <th className="border-b border-zinc-200 px-4 py-3 font-medium text-zinc-600">Date</th>
                  <th className="border-b border-zinc-200 px-4 py-3 font-medium text-zinc-600">Size</th>
                  <th className="border-b border-zinc-200 px-4 py-3 font-medium text-zinc-600">Status</th>
                  <th className="border-b border-zinc-200 px-4 py-3 font-medium text-zinc-600">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredDocuments.length === 0 ? (
                  <tr>
                    <td className="px-4 py-8 text-center text-zinc-500" colSpan={6}>
                      No documents found.
                    </td>
                  </tr>
                ) : (
                  filteredDocuments.map((doc) => (
                    <tr key={doc.id} className="hover:bg-zinc-50">
                      <td className="border-b border-zinc-100 px-4 py-3 text-zinc-800">{doc.name}</td>
                      <td className="border-b border-zinc-100 px-4 py-3 text-zinc-600">{doc.type}</td>
                      <td className="border-b border-zinc-100 px-4 py-3 text-zinc-600">{formatDate(doc.date)}</td>
                      <td className="border-b border-zinc-100 px-4 py-3 text-zinc-600">{formatBytes(doc.size)}</td>
                      <td className="border-b border-zinc-100 px-4 py-3">
                        <span
                          className={`rounded-full px-2 py-1 text-xs font-medium ${
                            doc.status === "Indexed"
                              ? "bg-emerald-100 text-emerald-700"
                              : doc.status === "Upload failed"
                                ? "bg-red-100 text-red-700"
                                : "bg-amber-100 text-amber-700"
                          }`}
                        >
                          {doc.status}
                        </span>
                      </td>
                      <td className="border-b border-zinc-100 px-4 py-3">
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => onViewDocument(doc)}
                            className="rounded-lg border border-zinc-200 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-100"
                          >
                            View
                          </button>
                          <button
                            type="button"
                            onClick={() => onEditDocument(doc.id)}
                            className="rounded-lg border border-zinc-200 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-100"
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => onDeleteDocument(doc.id)}
                            className="rounded-lg border border-red-200 px-2 py-1 text-xs text-red-700 hover:bg-red-50"
                          >
                            Delete
                          </button>
                          <button
                            type="button"
                            onClick={() => onReindexDocument(doc.id)}
                            className="rounded-lg border border-zinc-200 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-100"
                          >
                            Re-index
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
