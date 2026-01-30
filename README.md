# vladbot

A personal AI agent platform built for a single user. I wanted something more controllable than the clawdbot — full visibility into what the model sees, manual tool approval, VNC remote desktop control, persistent memory, and multi-device access to the same session. So I built this.

## What it does

vladbot is a self-hosted chat interface that connects to multiple LLM providers (Anthropic, Google, DeepSeek) and gives the agent access to tools: a shell, a filesystem, a VNC remote desktop, and a persistent memory store. Everything runs through a WebSocket connection so multiple devices (phone, laptop, desktop) can watch and interact with the same session in real time.

The agent can control a desktop over VNC — take screenshots, move the mouse, click, type, scroll — with human-like input timing. It can read and write files, run shell commands, search its own conversation history, and save things to memory for later. Tool calls require manual approval by default (or can be auto-approved per session).

## Architecture

Monorepo with three packages:

```
packages/
  shared/    - Types and model definitions
  backend/   - Express + WebSocket server, tool execution, LLM streaming
  frontend/  - React UI (Vite)
```

- **Frontend**: React 19, TypeScript, Vite 6
- **Backend**: Express 5, WebSocket (ws), TypeScript
- **Database**: PostgreSQL
- **LLM providers**: Anthropic (Claude Sonnet 4, Haiku 3.5), Google (Gemini 2.5 Pro/Flash, 2.0 Flash), DeepSeek (V3, R1)

## Tools

| Tool | What it does |
|---|---|
| **vnc** | Screenshot, click, type, scroll, move mouse, find UI elements via vision. Human-like input timing. Connection pooling with idle timeout. |
| **filesystem** | Read, write, append, delete, copy, move, mkdir, chmod, symlink, search (glob), stat, recursive directory listing. |
| **run_command** | Execute shell commands with configurable timeout (default 30s, max 5min). |
| **memory** | Save, search, list, update, delete persistent notes with tags. Full-text search. Token-budgeted storage. |
| **chat_history** | Search messages in the current session or across all sessions. |
| **vision** | Analyze images using a vision-capable model (when configured). |

## Multi-device sync

All state flows through WebSocket. When you approve a tool call on your phone, your desktop sees it immediately. Session creation, deletion, title changes, settings updates, and streaming events are all broadcast to every connected client. There's no polling.

## Context management

Token usage is tracked per message. When the context window fills up (~80% by default), the backend automatically compacts older messages into a summary while keeping the most recent N messages verbatim (configurable). You can also trigger compaction manually or when switching to a model with a smaller context window.

## Setup

### Prerequisites

- Node.js 20+
- PostgreSQL with pgvector
- At least one API key (Anthropic, Google, or DeepSeek)

### Database

```bash
docker compose -f docker/postgres/docker-compose.yml up -d
```

### Environment

Create a `.env` file in the project root:

```bash
# At least one required
ANTHROPIC_API_KEY=sk-ant-...
GOOGLE_GEMINI_API_KEY=AI...
DEEPSEEK_API_KEY=sk-...

# Database (required)
DATABASE_URL=postgresql://vladbot:vladbot@localhost:5432/vladbot

# Server port
PORT=3001
```

Optional:

```bash
# Vision model for providers without native vision (format: provider:model_id)
VISION_MODEL=gemini:gemini-2.0-flash

# VNC coordinate detection backend: "vision" (default) or "showui"
VNC_COORDINATE_BACKEND=vision

# ShowUI API URL (if using showui backend)
SHOWUI_API_URL=http://localhost:7860

# VNC idle timeout in seconds (0 = never disconnect)
VNC_CONNECTION_TIMEOUT=300
```

### Run

```bash
npm install

# Terminal 1
npm run dev:backend

# Terminal 2
npm run dev:frontend
```

Frontend: `http://localhost:5173` — Backend: `http://localhost:3001`

### Build

```bash
npm run build
```

## Runtime settings

These are configurable from the Settings page in the UI and persist to the database:

- Default model and vision model
- System prompt
- Auto-approve tool calls
- Context compaction threshold and verbatim tail budget
- Memory storage and return token limits
- VNC coordinate backend and keepalive timeout
- Messages page size

## Tests

```bash
# Backend (351 tests)
npm test -w @vladbot/backend

# Frontend (59 tests)
npm test -w @vladbot/frontend
```
