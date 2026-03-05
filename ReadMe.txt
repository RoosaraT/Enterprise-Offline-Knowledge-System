1) Requirements

Linux server (Ubuntu 22.04 recommended)
Node.js 20+
Ollama installed
Ports: 80/443 for web, 3001 for backend (or proxy)


2) Install Ollama + models

# install Ollama (see official installer)
ollama pull llama3.1:8b
ollama pull nomic-embed-text
Make sure Ollama is running on http://localhost:11434.


3) Backend setup

cd backend
npm install
Set env vars (example):

JWT_SECRET=change-this
FRONTEND_ORIGIN=http://your-domain-or-ip
OLLAMA_BASE=http://localhost:11434

Start backend:

node server.js
(Production: use pm2 or systemd.)


4) Frontend setup

cd local-doc-ai-frontend
npm install
npm run build
Serve local-doc-ai-frontend/dist with a web server.


5) Reverse proxy (nginx example)

Serve frontend from / (static)
Proxy /api → http://localhost:3001


6) Data persistence
Keep these folders backed up:

auth.db
backend/uploads/
backend/tmp/sessions/


Tech Stack

Frontend: React 19, Vite, Tailwind CSS
Backend: Node.js (Express), SQLite (better‑sqlite3), JWT auth, Multer
AI: Ollama (LLM + embeddings)


User Guide

Start services
Start Ollama and pull models (llama3.1:8b, nomic-embed-text)
Start backend (node server.js)
Start frontend (npm run dev or serve build)
Admin flow
Log in as admin (admin@company.com) (pwd: admin1234)
Upload PDFs (stored on server and indexed)
Manage users in Admin > Users
User flow
Log in as a normal user (testuser@company.com) (pwd: testuser1234)
Chat with the AI
AI answers from admin‑uploaded documents
Settings
Admin Settings control org name, default role, registration
User Settings control chat preferences