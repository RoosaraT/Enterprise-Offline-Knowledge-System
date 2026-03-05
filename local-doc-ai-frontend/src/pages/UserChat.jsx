import React, { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import Button from "../components/Button.jsx";
import whiteBin from "../assets/white-bin.png";
import blackBin from "../assets/black-bin.png";

export default function UserChat() {
  const nav = useNavigate();
  const messagesEndRef = useRef(null);

  const [sessions, setSessions] = useState([]);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [panel, setPanel] = useState("chat"); // chat | settings

  const [displayName, setDisplayName] = useState("User");
  const [autoScroll, setAutoScroll] = useState(true);
  const [statusMsg, setStatusMsg] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");

  const activeSession = useMemo(() => sessions.find((s) => s.id === activeSessionId) || null, [sessions, activeSessionId]);

  useEffect(() => {
    async function loadSessions() {
      setErrorMsg("");
      try {
        const token = localStorage.getItem("auth_token");
        const res = await fetch("/api/chat/sessions", {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || "Failed to load sessions");
        const list = data?.sessions || [];
        setSessions(list);
        if (list.length > 0) setActiveSessionId(list[0].id);
        if (list.length === 0) await createNewSession();
      } catch (err) {
        setErrorMsg(err?.message || "Failed to load sessions.");
      }
    }
    loadSessions();
  }, []);

  useEffect(() => {
    async function loadUserSettings() {
      setErrorMsg("");
      try {
        const token = localStorage.getItem("auth_token");
        const res = await fetch("/api/user-settings", {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || "Failed to load settings");
        if (data?.display_name) setDisplayName(data.display_name);
        if (data?.auto_scroll !== undefined) setAutoScroll(Boolean(data.auto_scroll));
      } catch (err) {
        setErrorMsg(err?.message || "Failed to load settings.");
      }
    }
    loadUserSettings();
  }, []);

  useEffect(() => {
    async function loadMessages() {
      if (!activeSessionId) return;
      setErrorMsg("");
      try {
        const token = localStorage.getItem("auth_token");
        const res = await fetch(`/api/chat/sessions/${activeSessionId}/messages`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || "Failed to load messages");
        const rows = data?.messages || [];
        if (rows.length === 0) {
          setMessages([
            {
              role: "assistant",
              text: "Hi. Ask me anything about uploaded documents.",
            },
          ]);
        } else {
          setMessages(rows.map((m) => ({ role: m.role, text: m.content })));
        }
      } catch (err) {
        setErrorMsg(err?.message || "Failed to load messages.");
      }
    }
    loadMessages();
  }, [activeSessionId]);

  useEffect(() => {
    if (activeSession) setRenameValue(activeSession.title || "");
  }, [activeSession]);

  useEffect(() => {
    if (autoScroll) messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeSessionId, autoScroll]);

  function onLogout() {
    localStorage.removeItem("auth_token");
    localStorage.removeItem("home_route");
    nav("/login", { replace: true });
  }

  async function createNewSession() {
    const token = localStorage.getItem("auth_token");
    const res = await fetch("/api/chat/sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || "Failed to create session");
    const session = data?.session;
    setSessions((prev) => [session, ...prev]);
    setActiveSessionId(session.id);
  }

  async function onNewChat() {
    setPanel("chat");
    setStatusMsg("");
    setErrorMsg("");
    try {
      await createNewSession();
    } catch (err) {
      setErrorMsg(err?.message || "Failed to create session.");
    }
  }

  async function sendMessage() {
    const text = input.trim();
    if (!text || sending || !activeSession) return;

    setInput("");
    setStatusMsg("");
    setErrorMsg("");

    setMessages((prev) => [...prev, { role: "user", text }]);

    try {
      setSending(true);
      const token = localStorage.getItem("auth_token");
      if (!token) throw new Error("Missing auth token. Please log in again.");

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ message: text, topK: 6, sessionId: activeSession.id }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `Chat request failed (${res.status})`);

      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: data?.reply || "No response.", sources: data?.sources || [] },
      ]);
      if (data?.sessionId && data.sessionId !== activeSession.id) {
        setActiveSessionId(data.sessionId);
      }
      setSessions((prev) =>
        prev.map((s) =>
          s.id === activeSession.id && s.title === "New chat"
            ? { ...s, title: text.slice(0, 36) + (text.length > 36 ? "..." : "") }
            : s
        )
      );
    } catch (err) {
      setMessages((prev) => [...prev, { role: "assistant", text: err?.message || "Unable to reach backend." }]);
    } finally {
      setSending(false);
    }
  }

  async function renameSession() {
    if (!activeSession) return;
    const nextTitle = renameValue.trim();
    if (!nextTitle) return;
    setErrorMsg("");
    try {
      const token = localStorage.getItem("auth_token");
      const res = await fetch(`/api/chat/sessions/${activeSession.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ title: nextTitle }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Rename failed");
      setSessions((prev) => prev.map((s) => (s.id === activeSession.id ? data.session : s)));
      setRenaming(false);
    } catch (err) {
      setErrorMsg(err?.message || "Rename failed.");
    }
  }

  async function exportChat() {
    if (!activeSession) return;
    setErrorMsg("");
    try {
      const token = localStorage.getItem("auth_token");
      const res = await fetch(`/api/chat/sessions/${activeSession.id}/export`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Export failed");
      const content = data?.text || "";
      const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(data?.session?.title || "chat").replace(/[^a-zA-Z0-9_-]+/g, "_")}.txt`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setErrorMsg(err?.message || "Export failed.");
    }
  }

  async function deleteChat(sessionId) {
    setStatusMsg("");
    setErrorMsg("");
    try {
      const token = localStorage.getItem("auth_token");
      const res = await fetch(`/api/chat/sessions/${sessionId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Delete failed");

      const nextSessions = sessions.filter((s) => s.id !== sessionId);
      setSessions(nextSessions);

      if (sessionId === activeSessionId) {
        if (nextSessions.length > 0) {
          setActiveSessionId(nextSessions[0].id);
        } else {
          await createNewSession();
        }
      }
    } catch (err) {
      setErrorMsg(err?.message || "Delete failed.");
    }
  }

  async function onSaveSettings(e) {
    e.preventDefault();
    setStatusMsg("");
    setErrorMsg("");
    try {
      const token = localStorage.getItem("auth_token");
      const res = await fetch("/api/user-settings", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          display_name: displayName,
          auto_scroll: autoScroll,
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
        <aside className="w-full border-r border-zinc-200 bg-white p-4 md:h-screen md:w-72 md:shrink-0 md:overflow-auto">
          <div className="mb-4">
            <div className="text-sm font-semibold text-zinc-900">User Workspace</div>
            <div className="text-xs text-zinc-500">Text chat with offline AI assistant</div>
          </div>

          <Button onClick={onNewChat}>New Chat</Button>

          <div className="mt-5">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Recent Chats</div>
            <div className="space-y-2">
              {sessions.length === 0 ? (
                <div className="rounded-lg border border-zinc-200 px-3 py-2 text-xs text-zinc-500">No chats yet</div>
              ) : (
                sessions.map((chat) => (
                  <div
                    key={chat.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      setActiveSessionId(chat.id);
                      setPanel("chat");
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        setActiveSessionId(chat.id);
                        setPanel("chat");
                      }
                    }}
                    className={`group relative block w-full rounded-lg border px-3 py-2 text-left text-sm transition ${
                      chat.id === activeSessionId
                        ? "border-zinc-900 bg-zinc-900 text-white"
                        : "border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50"
                    }`}
                  >
                    <div className="truncate pr-7">{chat.title}</div>
                    <button
                      type="button"
                      aria-label={`Delete ${chat.title}`}
                      title="Delete chat"
                      onClick={(e) => {
                        e.stopPropagation();
                        void deleteChat(chat.id);
                      }}
                      className="absolute right-2 top-1/2 hidden -translate-y-1/2 rounded p-1 group-hover:block"
                    >
                      <img
                        src={chat.id === activeSessionId ? whiteBin : blackBin}
                        alt=""
                        className="h-4 w-4"
                      />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="mt-5 space-y-2">
            <button
              type="button"
              onClick={() => setPanel("settings")}
              className="block w-full rounded-lg border border-zinc-200 px-3 py-2 text-left text-sm text-zinc-700 hover:bg-zinc-50"
            >
              Settings
            </button>
            <Button variant="secondary" onClick={onLogout}>
              Log out
            </Button>
          </div>
        </aside>

        <main className="min-w-0 flex-1 bg-white p-4 md:h-screen md:overflow-hidden md:p-6">
          {panel === "settings" ? (
            <form onSubmit={onSaveSettings} className="max-w-xl space-y-4 rounded-xl border border-zinc-200 bg-white p-4">
              <div>
                <h1 className="text-xl font-semibold text-zinc-900">Settings</h1>
                <p className="text-sm text-zinc-500">Basic chat preferences.</p>
              </div>

              <label className="block">
                <span className="mb-1 block text-sm text-zinc-600">Display Name</span>
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  className="w-full rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-zinc-400 focus:ring-4 focus:ring-zinc-100"
                />
              </label>

              <label className="flex items-center gap-3 rounded-xl border border-zinc-200 px-4 py-3 text-sm text-zinc-700">
                <input
                  type="checkbox"
                  checked={autoScroll}
                  onChange={(e) => setAutoScroll(e.target.checked)}
                  className="h-4 w-4"
                />
                Auto-scroll to latest message
              </label>

              <div className="flex gap-2">
                <Button type="submit">Save Settings</Button>
                <Button type="button" variant="secondary" onClick={() => setPanel("chat")}>
                  Back to Chat
                </Button>
              </div>

              {statusMsg ? (
                <div className="rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-2 text-sm text-zinc-700">{statusMsg}</div>
              ) : null}
              {errorMsg ? (
                <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{errorMsg}</div>
              ) : null}
            </form>
          ) : (
            <div className="flex h-full flex-col rounded-xl border border-zinc-200">
              <div className="border-b border-zinc-200 px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-zinc-900">AI Chat</div>
                    <div className="text-xs text-zinc-500">Text-only chat with your local document assistant</div>
                  </div>
                  <div className="flex gap-2">
                    <Button variant="secondary" onClick={exportChat}>
                      Export
                    </Button>
                    <Button variant="secondary" onClick={() => setRenaming((v) => !v)}>
                      {renaming ? "Cancel" : "Rename"}
                    </Button>
                  </div>
                </div>
                {renaming ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <input
                      type="text"
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      className="w-full flex-1 rounded-xl border border-zinc-200 bg-white px-4 py-2 text-sm outline-none transition focus:border-zinc-400 focus:ring-4 focus:ring-zinc-100"
                    />
                    <Button onClick={renameSession}>Save</Button>
                  </div>
                ) : null}
              </div>
              {errorMsg ? (
                <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{errorMsg}</div>
              ) : null}

              <div className="flex-1 overflow-y-auto bg-zinc-50 p-4">
                {messages.map((msg, idx) => (
                  <div key={`${idx}-${msg.role}`} className={`mb-3 flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                    <div
                      className={`max-w-3xl rounded-2xl px-4 py-3 text-sm ${
                        msg.role === "user" ? "bg-zinc-900 text-white" : "border border-zinc-200 bg-white text-zinc-800"
                      }`}
                    >
                      {msg.text}
                      {msg.role === "assistant" && msg.sources && msg.sources.length > 0 ? (
                        <div className="mt-2 border-t border-zinc-200/60 pt-2 text-xs text-zinc-500">
                          Sources: {msg.sources.join(", ")}
                        </div>
                      ) : null}
                    </div>
                  </div>
                ))}
                <div ref={messagesEndRef} />
              </div>

              <div className="border-t border-zinc-200 bg-white p-3">
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder="Type your message..."
                    className="w-full rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-zinc-400 focus:ring-4 focus:ring-zinc-100"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") sendMessage();
                    }}
                  />
                  <Button onClick={sendMessage} disabled={sending || !input.trim()}>
                    {sending ? "Sending..." : "Send"}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
