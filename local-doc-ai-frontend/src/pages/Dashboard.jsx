// src/pages/Dashboard.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import Button from "../components/Button.jsx";
import AdminSidebar from "../components/AdminSidebar.jsx";
import sortIcon from "../assets/sort.png";
import { apiFetch } from "../lib/auth.js";

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

function mapRowsToDocuments(rows) {
  const grouped = new Map();

  for (const row of rows || []) {
    const key = row.original_name;
    if (!grouped.has(key)) {
      grouped.set(key, {
        id: `db-${row.id}`,
        fileId: row.id,
        fileIds: [row.id],
        name: row.original_name,
        type: typeFromName(row.original_name),
        date: row.uploaded_at,
        size: row.size_bytes || 0,
        status: "Indexed",
      });
      continue;
    }

    const current = grouped.get(key);
    current.fileIds.push(row.id);
  }

  return Array.from(grouped.values());
}

export default function Dashboard() {
  const fileInputRef = useRef(null);
  const typeMenuRef = useRef(null);
  const dateMenuRef = useRef(null);
  const sizeMenuRef = useRef(null);

  const [documents, setDocuments] = useState([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusMsg, setStatusMsg] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [uploading, setUploading] = useState(false);
  const [loadingDocuments, setLoadingDocuments] = useState(true);
  const [selectedType, setSelectedType] = useState("all");
  const [typeMenuOpen, setTypeMenuOpen] = useState(false);
  const [dateMenuOpen, setDateMenuOpen] = useState(false);
  const [dateSortOrder, setDateSortOrder] = useState("newest");
  const [sizeMenuOpen, setSizeMenuOpen] = useState(false);
  const [activeSortField, setActiveSortField] = useState("date");
  const [sizeSortOrder, setSizeSortOrder] = useState("largest");
  const [reindexingIds, setReindexingIds] = useState([]);

  async function uploadToBackend(files) {
    const formData = new FormData();
    for (const file of files) formData.append("files", file);

    const res = await apiFetch("/api/upload", {
      method: "POST",
      body: formData,
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || `Upload failed (${res.status})`);
    return data;
  }

  async function loadDocuments() {
    setLoadingDocuments(true);
    setErrorMsg("");
    try {
      const res = await apiFetch("/api/files");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `Load failed (${res.status})`);

      const mapped = mapRowsToDocuments(data?.files || []);
      setDocuments(mapped);
    } catch (err) {
      setErrorMsg(err?.message || "Failed to load documents");
    } finally {
      setLoadingDocuments(false);
    }
  }

  useEffect(() => {
    loadDocuments();
  }, []);

  useEffect(() => {
    function handleFocus() {
      loadDocuments();
    }

    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, []);

  useEffect(() => {
    function handlePointerDown(event) {
      const target = event.target;

      if (typeMenuRef.current && !typeMenuRef.current.contains(target)) {
        setTypeMenuOpen(false);
      }
      if (dateMenuRef.current && !dateMenuRef.current.contains(target)) {
        setDateMenuOpen(false);
      }
      if (sizeMenuRef.current && !sizeMenuRef.current.contains(target)) {
        setSizeMenuOpen(false);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, []);

  useEffect(() => {
    if (!statusMsg) return undefined;
    const timeoutId = window.setTimeout(() => setStatusMsg(""), 3000);
    return () => window.clearTimeout(timeoutId);
  }, [statusMsg]);

  async function onUploadSelected(fileList) {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;

    setErrorMsg("");
    setStatusMsg("");

    try {
      setUploading(true);
      setStatusMsg("Uploading and indexing documents...");
      await uploadToBackend(files);
      await loadDocuments();
      setStatusMsg("Upload complete.");
    } catch (err) {
      setErrorMsg(err?.message || "Upload failed");
      setStatusMsg("");
    } finally {
      setUploading(false);
    }
  }

  async function onDeleteDocument(doc) {
    const confirmed = window.confirm(`Delete "${doc.name}"? This will remove it from storage and the database.`);
    if (!confirmed) return;

    setStatusMsg("");
    setErrorMsg("");
    try {
      const fileIds =
        Array.isArray(doc.fileIds) && doc.fileIds.length > 0
          ? doc.fileIds
          : [
              doc.fileId ??
                (typeof doc.id === "string" && doc.id.startsWith("db-") ? Number(doc.id.slice(3)) : Number(doc.id)),
            ];

      for (const fileId of fileIds) {
        if (!fileId || Number.isNaN(fileId)) continue;
        const res = await apiFetch(`/api/files/${fileId}`, {
          method: "DELETE",
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const isAlreadyGone = res.status === 404 && data?.error === "File not found";
          if (!isAlreadyGone) throw new Error(data?.error || `Delete failed (${res.status})`);
        }
      }

      await loadDocuments();
      const successText = `Deleted "${doc.name}" successfully.`;
      setStatusMsg(successText);
    } catch (err) {
      setErrorMsg(err?.message ? `Delete failed: ${err.message}` : "Delete failed.");
    }
  }

  async function onViewDocument(doc) {
    setStatusMsg("");
    setErrorMsg("");
    try {
      const resolvedFileId =
        doc.fileId ??
        (typeof doc.id === "string" && doc.id.startsWith("db-") ? Number(doc.id.slice(3)) : Number(doc.id));

      if (!resolvedFileId || Number.isNaN(resolvedFileId)) {
        throw new Error("Missing file id");
      }

      const res = await apiFetch(`/api/files/${resolvedFileId}/view`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || `View failed (${res.status})`);
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener,noreferrer");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      setErrorMsg(err?.message || "View failed");
    }
  }

  async function onReindexDocument(doc) {
    setStatusMsg("");
    setErrorMsg("");
    setReindexingIds((prev) => [...new Set([...prev, doc.id])]);
    setDocuments((prev) => prev.map((d) => (d.id === doc.id ? { ...d, status: "Indexing" } : d)));

    try {
      const fileId =
        doc.fileId ??
        (typeof doc.id === "string" && doc.id.startsWith("db-") ? Number(doc.id.slice(3)) : Number(doc.id));

      if (!fileId || Number.isNaN(fileId)) {
        throw new Error("Missing file id");
      }

      const res = await apiFetch(`/api/files/${fileId}/reindex`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `Re-index failed (${res.status})`);

      await loadDocuments();
      setStatusMsg(`Re-indexed "${doc.name}" successfully.`);
    } catch (err) {
      setDocuments((prev) => prev.map((d) => (d.id === doc.id ? { ...d, status: "Indexed" } : d)));
      setErrorMsg(err?.message || "Re-index failed");
    } finally {
      setReindexingIds((prev) => prev.filter((id) => id !== doc.id));
    }
  }

  const filteredDocuments = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const filtered = !q
      ? [...documents]
      : documents.filter(
      (doc) =>
        doc.name.toLowerCase().includes(q) ||
        doc.type.toLowerCase().includes(q) ||
        doc.status.toLowerCase().includes(q),
    );

    const typeFiltered =
      selectedType === "all" ? filtered : filtered.filter((doc) => doc.type.toLowerCase() === selectedType.toLowerCase());

    typeFiltered.sort((a, b) => {
      if (activeSortField === "size") {
        return sizeSortOrder === "smallest" ? a.size - b.size : b.size - a.size;
      }
      const aTime = new Date(a.date).getTime();
      const bTime = new Date(b.date).getTime();
      return dateSortOrder === "oldest" ? aTime - bTime : bTime - aTime;
    });

    return typeFiltered;
  }, [documents, searchQuery, selectedType, dateSortOrder, activeSortField, sizeSortOrder]);

  const documentTypes = useMemo(() => {
    return Array.from(new Set(documents.map((doc) => doc.type).filter(Boolean))).sort((a, b) => a.localeCompare(b));
  }, [documents]);

  return (
    <div className="min-h-screen w-full bg-zinc-100">
      <div className="flex min-h-screen w-full flex-col md:flex-row">
        <AdminSidebar active="documents" />

        <main className="min-w-0 flex-1 bg-white p-4 md:h-screen md:overflow-auto md:p-6">
          {statusMsg ? (
            <div className="fixed right-4 top-4 z-20 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700 shadow-lg">
              {statusMsg}
            </div>
          ) : null}

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

          {errorMsg ? (
            <div className="mb-3 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{errorMsg}</div>
          ) : null}

          <div className="overflow-x-auto rounded-xl border border-zinc-200">
            <table className="min-w-full border-collapse text-sm">
              <thead className="bg-zinc-50 text-left">
                <tr>
                  <th className="border-b border-zinc-200 px-4 py-3 font-medium text-zinc-600">Name</th>
                  <th className="border-b border-zinc-200 px-4 py-3 font-medium text-zinc-600">
                    <div ref={typeMenuRef} className="relative inline-flex items-center gap-1">
                      <span>Type</span>
                      <button
                        type="button"
                        onClick={() => setTypeMenuOpen((open) => !open)}
                        className="inline-flex h-5 w-5 items-center justify-center rounded text-xs text-zinc-500 hover:bg-zinc-200 hover:text-zinc-700"
                        aria-label="Filter documents by type"
                      >
                        <img src={sortIcon} alt="" className="h-3.5 w-3.5" />
                      </button>
                      {typeMenuOpen ? (
                        <div className="absolute left-0 top-full z-10 mt-2 min-w-36 rounded-xl border border-zinc-200 bg-white p-2 shadow-lg">
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedType("all");
                              setTypeMenuOpen(false);
                            }}
                            className={`block w-full rounded-lg px-3 py-2 text-left text-sm ${
                              selectedType === "all" ? "bg-zinc-100 text-zinc-900" : "text-zinc-700 hover:bg-zinc-50"
                            }`}
                          >
                            All types
                          </button>
                          {documentTypes.map((type) => (
                            <button
                              key={type}
                              type="button"
                              onClick={() => {
                                setSelectedType(type);
                                setTypeMenuOpen(false);
                              }}
                              className={`block w-full rounded-lg px-3 py-2 text-left text-sm ${
                                selectedType === type ? "bg-zinc-100 text-zinc-900" : "text-zinc-700 hover:bg-zinc-50"
                              }`}
                            >
                              {type}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </th>
                  <th className="border-b border-zinc-200 px-4 py-3 font-medium text-zinc-600">
                    <div ref={dateMenuRef} className="relative inline-flex items-center gap-1">
                      <span>Date</span>
                      <button
                        type="button"
                        onClick={() => setDateMenuOpen((open) => !open)}
                        className="inline-flex h-5 w-5 items-center justify-center rounded text-xs text-zinc-500 hover:bg-zinc-200 hover:text-zinc-700"
                        aria-label="Sort documents by upload date"
                      >
                        <img src={sortIcon} alt="" className="h-3.5 w-3.5" />
                      </button>
                      {dateMenuOpen ? (
                        <div className="absolute left-0 top-full z-10 mt-2 min-w-40 rounded-xl border border-zinc-200 bg-white p-2 shadow-lg">
                          <button
                            type="button"
                            onClick={() => {
                              setActiveSortField("date");
                              setDateSortOrder("newest");
                              setDateMenuOpen(false);
                            }}
                            className={`block w-full rounded-lg px-3 py-2 text-left text-sm ${
                              dateSortOrder === "newest" ? "bg-zinc-100 text-zinc-900" : "text-zinc-700 hover:bg-zinc-50"
                            }`}
                          >
                            Newest first
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setActiveSortField("date");
                              setDateSortOrder("oldest");
                              setDateMenuOpen(false);
                            }}
                            className={`block w-full rounded-lg px-3 py-2 text-left text-sm ${
                              dateSortOrder === "oldest" ? "bg-zinc-100 text-zinc-900" : "text-zinc-700 hover:bg-zinc-50"
                            }`}
                          >
                            Oldest first
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </th>
                  <th className="border-b border-zinc-200 px-4 py-3 font-medium text-zinc-600">
                    <div ref={sizeMenuRef} className="relative inline-flex items-center gap-1">
                      <span>Size</span>
                      <button
                        type="button"
                        onClick={() => setSizeMenuOpen((open) => !open)}
                        className="inline-flex h-5 w-5 items-center justify-center rounded text-xs text-zinc-500 hover:bg-zinc-200 hover:text-zinc-700"
                        aria-label="Sort documents by file size"
                      >
                        <img src={sortIcon} alt="" className="h-3.5 w-3.5" />
                      </button>
                      {sizeMenuOpen ? (
                        <div className="absolute left-0 top-full z-10 mt-2 min-w-40 rounded-xl border border-zinc-200 bg-white p-2 shadow-lg">
                          <button
                            type="button"
                            onClick={() => {
                              setActiveSortField("size");
                              setSizeSortOrder("largest");
                              setSizeMenuOpen(false);
                            }}
                            className={`block w-full rounded-lg px-3 py-2 text-left text-sm ${
                              activeSortField === "size" && sizeSortOrder === "largest"
                                ? "bg-zinc-100 text-zinc-900"
                                : "text-zinc-700 hover:bg-zinc-50"
                            }`}
                          >
                            Largest first
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setActiveSortField("size");
                              setSizeSortOrder("smallest");
                              setSizeMenuOpen(false);
                            }}
                            className={`block w-full rounded-lg px-3 py-2 text-left text-sm ${
                              activeSortField === "size" && sizeSortOrder === "smallest"
                                ? "bg-zinc-100 text-zinc-900"
                                : "text-zinc-700 hover:bg-zinc-50"
                            }`}
                          >
                            Smallest first
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </th>
                  <th className="border-b border-zinc-200 px-4 py-3 font-medium text-zinc-600">Status</th>
                  <th className="border-b border-zinc-200 px-4 py-3 font-medium text-zinc-600">Actions</th>
                </tr>
              </thead>
              <tbody>
                {loadingDocuments ? (
                  <tr>
                    <td className="px-4 py-8 text-center text-zinc-500" colSpan={6}>
                      Loading documents...
                    </td>
                  </tr>
                ) : filteredDocuments.length === 0 ? (
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
                          {(() => {
                            const isReindexing = reindexingIds.includes(doc.id);
                            return (
                              <>
                          <button
                            type="button"
                            onClick={() => onViewDocument(doc)}
                            disabled={isReindexing}
                            className="rounded-lg border border-zinc-200 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            View
                          </button>
                          <button
                            type="button"
                            onClick={() => onDeleteDocument(doc)}
                            disabled={isReindexing}
                            className="rounded-lg border border-red-200 px-2 py-1 text-xs text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            Delete
                          </button>
                          <button
                            type="button"
                            onClick={() => onReindexDocument(doc)}
                            disabled={isReindexing}
                            className="rounded-lg border border-zinc-200 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {isReindexing ? "Re-indexing..." : "Re-index"}
                          </button>
                              </>
                            );
                          })()}
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
