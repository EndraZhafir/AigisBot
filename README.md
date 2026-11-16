# AigisBot — ATLUS Community WhatsApp Bot (Backend)

Bot grup WhatsApp bertema **Aigis** (*Persona 3*) untuk komunitas game **ATLUS**, dibangun menggunakan **Node.js + TypeScript**, **`@whiskeysockets/baileys`**, built-in **`node:sqlite`**, dan **Google Gemini API (Free Tier)**.

## Arsitektur Polyrepo
* `backend/` *(Repo ini)* — Gateway WhatsApp Multi-Device, `@mention`/reply router, Persona Brain, SQLite context memory, rate limiter, dan auto-moderation.
* `frontend/` *(Planned Post-MVP)* — Repositori terpisah untuk Admin Web UI.

## Prasyarat Lokal
* **Node.js `v22+`** (mendukung `node:sqlite` bawaan tanpa build C++ `node-gyp`)
* **Nomor WhatsApp sekunder** khusus bot (jangan gunakan nomor pribadi utama)

## Setup Cepat
1. Salin `.env.example` menjadi `.env`:
   ```powershell
   Copy-Item .env.example .env
   ```
2. Install dependencies:
   ```powershell
   npm install
   ```
3. Jalankan typecheck & unit tests:
   ```powershell
   npx tsc --noEmit
   npm test
   ```
4. Jalankan mode development:
   ```powershell
   npm run dev
   ```
