# Deployment And Backup Guide

## Overview

This system has three runtime parts:

1. Frontend: `local-doc-ai-frontend`
2. Backend: `backend`
3. Ollama: local LLM + embeddings service

Persistent application data lives here:

- `backend/auth.db`
- `backend/uploads/`
- `backend/tmp/sessions/`

These must be kept on persistent storage and included in backups.

## Requirements

### Linux or Windows server

- Node.js 20+
- Python 3
- Ollama installed locally
- Ollama models pulled:
  - `llama3.1:8b`
  - `nomic-embed-text`

### Environment variables

Set these before starting the backend:

- `JWT_SECRET`
- `FRONTEND_ORIGIN`
- `OLLAMA_BASE`
- optional: `PYTHON_BIN`

Example values:

```env
JWT_SECRET=replace-with-a-long-random-secret
FRONTEND_ORIGIN=http://localhost:5173
OLLAMA_BASE=http://localhost:11434
```

## Backend startup

From repo root:

```bash
cd backend
npm install
node server.js
```

### Windows PowerShell example

```powershell
cd backend
npm install
$env:JWT_SECRET="replace-with-a-long-random-secret"
$env:FRONTEND_ORIGIN="http://localhost:5173"
$env:OLLAMA_BASE="http://localhost:11434"
node server.js
```

## Frontend startup

Development:

```bash
cd local-doc-ai-frontend
npm install
npm run dev
```

Production build:

```bash
cd local-doc-ai-frontend
npm install
npm run build
```

Then serve `local-doc-ai-frontend/dist` from a web server.

## Ollama startup

Make sure Ollama is running locally and the models are available:

```bash
ollama pull llama3.1:8b
ollama pull nomic-embed-text
```

Default runtime URL:

```text
http://localhost:11434
```

## Production checklist

Before handing this to users:

1. Set a strong `JWT_SECRET`
2. Confirm `FRONTEND_ORIGIN` matches the real frontend URL
3. Confirm Ollama runs locally on the server
4. Confirm Python can run `backend/pdf_extract.py`
5. Test:
   - admin login
   - user login
   - PDF upload
   - chat response
   - file delete
   - file re-index
   - logout/login after user suspension

## Backup procedure

Back up these paths together:

```text
backend/auth.db
backend/uploads/
backend/tmp/sessions/
```

### Why all three

- `auth.db` contains users, settings, audit logs, file metadata, chunks, sessions, rate limits
- `uploads/` contains original uploaded files
- `tmp/sessions/` contains chat history per user

### Safe backup process

Preferred:

1. Stop backend
2. Copy the paths above
3. Start backend again

Automated backup command:

```bash
node scripts/backup.mjs
```

Optional custom destination:

```bash
node scripts/backup.mjs /path/to/backup-folder
```

If stopping is not possible, at minimum:

1. Copy `uploads/`
2. Copy `tmp/sessions/`
3. Copy `auth.db`

Stopping the backend first is safer for SQLite consistency.

### Example backup folder layout

```text
backup-YYYY-MM-DD/
  auth.db
  uploads/
  sessions/
```

## Restore procedure

1. Stop backend
2. Restore:
   - backup `auth.db` -> `backend/auth.db`
   - backup `uploads/` -> `backend/uploads/`
   - backup `sessions/` -> `backend/tmp/sessions/`
3. Start backend
4. Verify:
   - admin login works
   - uploaded files appear in Documents
   - chat sessions open correctly

## Update procedure

When updating the app on a server:

1. Back up data first
2. Stop backend/frontend services
3. Replace code
4. Run:

```bash
cd backend && npm install
cd ../local-doc-ai-frontend && npm install && npm run build
```

5. Start backend
6. Start or reload frontend hosting
7. Test admin login, upload, and chat

## Notes

- One browser profile still uses one active session cookie set.
- For simultaneous admin and user testing on one machine, use separate browser profiles or an incognito window.
- Re-indexing now rebuilds document chunks from the stored file on disk.
