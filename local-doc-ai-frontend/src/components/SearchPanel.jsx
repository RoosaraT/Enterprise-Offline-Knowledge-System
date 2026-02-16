import React, { useMemo, useState } from "react";
import Button from "./Button.jsx";

export default function SearchPanel({ files }) {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState("exact"); // exact | context
  const [loading, setLoading] = useState(false);

  const [error, setError] = useState("");
  const [results, setResults] = useState([]); // for exact
  const [answer, setAnswer] = useState(""); // for context
  const [citations, setCitations] = useState([]); // for context evidence

  const canSearch = useMemo(() => query.trim().length > 0, [query]);

  async function handleSearch() {
    setLoading(true);
    setError("");
    setResults([]);
    setAnswer("");
    setCitations([]);

    try {
      const token = localStorage.getItem("auth_token");
      if (!token) {
        setError("Missing auth token. Please log in again.");
        return;
      }

      // Context (AI) mode -> /api/ask
      if (mode === "context") {
        const res = await fetch("/api/ask", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ question: query.trim(), topK: 6 }),
        });

        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(data?.error || `AI request failed (${res.status})`);
          return;
        }

        setAnswer(data?.answer || "");
        setCitations(data?.citations || []);
        return;
      }

      // Exact mode -> /api/search
      const res = await fetch("/api/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ query: query.trim(), topK: 20 }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error || `Search failed (${res.status})`);
        return;
      }

      setResults(data?.results || []);
    } catch (e) {
      setError("Server not reachable. Is the backend running?");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-sm font-semibold text-zinc-900">Search</div>
          <div className="text-xs text-zinc-500">Exact word search or offline AI context answers</div>
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setMode("exact")}
            className={[
              "rounded-xl px-3 py-2 text-xs font-medium border transition",
              mode === "exact"
                ? "border-zinc-900 bg-zinc-900 text-white"
                : "border-zinc-200 bg-white text-zinc-900 hover:bg-zinc-50",
            ].join(" ")}
          >
            Exact
          </button>
          <button
            type="button"
            onClick={() => setMode("context")}
            className={[
              "rounded-xl px-3 py-2 text-xs font-medium border transition",
              mode === "context"
                ? "border-zinc-900 bg-zinc-900 text-white"
                : "border-zinc-200 bg-white text-zinc-900 hover:bg-zinc-50",
            ].join(" ")}
          >
            Context (AI)
          </button>
        </div>
      </div>

      <div className="mt-4">
        <input
          className="w-full rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-zinc-400 focus:ring-4 focus:ring-zinc-100"
          placeholder={mode === "exact" ? "Type a word or exact phrase..." : "Ask a question about the uploaded text..."}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canSearch && !loading) handleSearch();
          }}
        />

        <div className="mt-3 flex items-center justify-between">
          <div className="text-xs text-zinc-500">
            {files.length === 0 ? "Upload TXT files first (PDF/DOCX later)." : "Press Enter or click Search."}
          </div>
          <Button onClick={handleSearch} disabled={!canSearch || loading}>
            {loading ? "Working..." : "Search"}
          </Button>
        </div>
      </div>

      {error ? (
        <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      ) : null}

      {/* Context (AI) output */}
      {mode === "context" ? (
        <div className="mt-5 space-y-3">
          {!answer && !loading && !error ? (
            <div className="rounded-xl border border-zinc-100 bg-zinc-50 p-4 text-sm text-zinc-600">
              Ask a question and you’ll get an answer + evidence from your uploaded files.
            </div>
          ) : null}

          {answer ? (
            <div className="rounded-xl border border-zinc-100 bg-white p-4">
              <div className="text-xs font-semibold text-zinc-900">Answer</div>
              <div className="mt-2 whitespace-pre-wrap text-sm text-zinc-700">{answer}</div>
            </div>
          ) : null}

          {citations.length > 0 ? (
            <div className="rounded-xl border border-zinc-100 bg-white p-4">
              <div className="text-xs font-semibold text-zinc-900">Evidence</div>
              <div className="mt-3 space-y-2">
                {citations.map((c) => (
                  <div key={`${c.file}-${c.location}-${c.source}`} className="rounded-xl border border-zinc-100 bg-zinc-50 p-3">
                    <div className="text-xs text-zinc-600">
                      <span className="font-semibold text-zinc-900">{c.file}</span> • {c.location} • source {c.source}
                    </div>
                    <div className="mt-2 text-sm text-zinc-700">{c.snippet}</div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        // Exact output
        <div className="mt-5 space-y-3">
          {results.length === 0 && !loading && !error ? (
            <div className="rounded-xl border border-zinc-100 bg-zinc-50 p-4 text-sm text-zinc-600">
              Results will show here with exact location.
            </div>
          ) : null}

          {results.map((r, i) => (
            <div key={i} className="rounded-xl border border-zinc-100 bg-white p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-zinc-900">{r.file}</div>
                  <div className="text-xs text-zinc-500">{r.location}</div>
                </div>
              </div>
              <div className="mt-3 text-sm text-zinc-700">{r.snippet}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
