# AigisBot — ATLUS Community WhatsApp Bot (Backend)

**Versi Saat Ini:** `v0.1.0` *(Core MVP)*  
**Target Karakter:** **Aigis** (*Anti-Shadow Suppression Weapon — 7th Generation*, *Persona 3 / Persona 3 Reload*)  
**Tech Stack:** Node.js `v22+` (`node:sqlite` built-in), TypeScript (`strict`, ESM), [`@whiskeysockets/baileys`](https://github.com/WhiskeySockets/Baileys), Google Gemini API (`@google/genai`), Groq API *(opsional fallback)*, & Pino logger

---

## 1. Ringkasan Proyek & Arsitektur Polyrepo

**AigisBot** adalah bot grup WhatsApp berbasis AI untuk komunitas game **ATLUS** (*Persona*, *Shin Megami Tensei*, *Soul Hackers*, *Metaphor: ReFantazio*, dll.). Karena WhatsApp Cloud API resmi hanya mendukung komunikasi bisnis *1-on-1*, bot berjalan melalui protokol **WhatsApp Web Multi-Device** menggunakan **nomor WhatsApp sekunder khusus bot** dan hanya aktif pada grup di daftar whitelist (`ALLOWED_GROUP_JIDS`).

Struktur polyrepo di bawah `D:\Projects\AigisBot\`:
* `backend/` *(Repositori ini)* — Gateway WhatsApp Baileys, `@mention`/`@lid` & reply router, Dual-Mode Persona Brain, memori SQLite bawaan, serta guard anti-flood & sanitizer.
* `frontend/` *(Planned Post-MVP)* — Repositori terpisah untuk Admin Web UI dashboard.

---

## 2. Fitur Utama (`v0.1.0` Core MVP)

### A. WhatsApp Gateway & `@lid` Mention/Reply Router *(Modul 1)*
* **Dual Auth:** Mendukung login **QR Code** maupun **8-digit Pairing Code** (`WA_PAIRING_PHONE`).
* **Group Whitelist & Discovery Mode:** Mengabaikan DM, status broadcast, dan `fromMe` (anti self-loop). Jika `ALLOWED_GROUP_JIDS` dikosongkan, bot masuk ke *Discovery Mode* dan mencatat JID grup ke log terminal untuk memudahkan setup awal.
* **Modern `@lid` + `@s.whatsapp.net` Resolver:** Mendeteksi `@mention` dan balasan langsung (*quoted reply*) ke pesan Aigis di grup modern yang memakai Linked ID (`@lid`), termasuk membungkus pesan *disappearing/ephemeral*.
* **Human-Like Dispatch & Safe Reconnect:** Simulasi status `composing` + jeda natural (`~1s`) sebelum *quoted reply* (`linkPreview: null`), serta *exponential backoff* aman (berhenti bersih pada `401 loggedOut` dan `440 connectionReplaced`).

### B. Dual-Mode Aigis Persona Brain & Auto-Translate *(Modul 2)*
* **Mode Santai (`casual`):** Roleplay S.E.E.S. dengan output JSON terstruktur. Default balasan menggunakan **Bahasa Inggris**, otomatis beralih ke **Bahasa Indonesia** (dengan selipan gaya Aigis) jika member menulis/meminta Bahasa Indonesia.
* **Quote-to-Translate:** Jika member menulis bahasa asing atau me-*reply* pesan berbahasa asing milik anggota lain sambil men-tag `@Aigis`, Aigis menampilkan blok `📡 *[Translation]*` terlebih dahulu sebelum bereaksi.
* **Mode Serius (`serious`):** Aktif otomatis saat ditanya berita/rilis/trailer game ATLUS. Mengambil feed RSS publik gratis (**Persona Central** & **Gematsu**, cache 15 menit) beserta tautan artikel/YouTube dan tanggal publikasi nyata untuk mencegah halusinasi.
* **Dark Hour & Spoiler Guard:** Kesadaran waktu `Asia/Jakarta` (`WIB`) untuk reaksi kontekstual pukul `00:00–00:59 WIB`, guardrail anti-spoiler *endgame* ATLUS, `runWith503Retry()`, serta rantai model fallback (`gemini-3.5-flash-lite` $\rightarrow$ `gemini-3.1-flash-lite` $\rightarrow$ optional Groq).

### C. Built-in `node:sqlite` Memory & Context Engine *(Modul 3)*
* **Zero Native Build Deps:** Memakai `node:sqlite` bawaan Node.js `v22+` (tanpa butuh compiler C++ `node-gyp`, jalan mulus di Windows, Linux VPS, maupun Termux).
* **Sliding-Window Konteks Grup:** Merekam pesan obrolan biasa di grup whitelist secara pasif + balasan Aigis (`group_messages`) dan menyuntikkan hingga `12` pesan terakhir ke prompt agar Aigis nyambung dengan topik yang sedang dibahas grup (*auto-pruning* per grup di batas `100` pesan).
* **Member Memory & Social Link Bond (`1–10`):** Menyatukan identitas `@lid` $\leftrightarrow$ `@s.whatsapp.net` saat nomor ter-resolve dan melacak *Bond Rank* interaksi member (`member_memories`).
* **Community Founder/Admin Dossier:** Memuat profil & trivia tokoh komunitas secara lokal dari file JSON ter-`.gitignore` (`data/community_seed.local.json`) ke tabel `community_trivia`, dengan penjagaan ketat agar nomor telepon pribadi tidak pernah diteruskan ke LLM atau dibocorkan ke chat.

### D. Anti-Flood Tiered Cooldown, Admin Detection & Sanitizer *(Modul 4)*
* **Deteksi Admin Grup Otomatis:** `GroupAdminResolver` memeriksa daftar `admin` / `superadmin` melalui `groupMetadata` WhatsApp (mendukung `@lid` & PN, dengan cache TTL 5 menit + invalidasi instan lewat event `group-participants.update`, serta fallback `BOT_OWNER_NUMBERS`).
* **Tiered Cooldown & In-Flight Lock:**
  * **Admin (Pro Tier):** Cooldown cepat per-user (`ADMIN_COOLDOWN_MS`, default `4s`) & per-grup (`ADMIN_GROUP_COOLDOWN_MS`, default `2s`).
  * **Member (Free Tier):** Cooldown standar per-user (`USER_COOLDOWN_MS`, default `15s`) & per-grup (`GROUP_COOLDOWN_MS`, default `5s`).
  * **In-Flight Mutex & Throttled `⏳`:** Tag beruntun saat bot sedang membalas ditolak bersih; maksimal hanya mengirim `1x` reaksi emoji `⏳` per jendela cooldown agar grup bebas spam teks maupun emoji.
* **Input Sanitizer:** Menghapus karakter *zero-width*/bidi tersembunyi, menormalkan spasi/baris berlebih, membatasi panjang spam prompt/quote, dan menetralkan upaya spoof header prompt internal atau delimiter `"""`.

---

## 3. Alur Pemrosesan Pesan & Struktur Direktori

```text
[Pesan Grup WA (messages.upsert)]
        │
        ├─▶ observeWhitelistedGroupMessage() ─▶ Sanitasi & simpan ke SQLite sliding window
        ▼
[routeIncomingMessage()] (Whitelist, anti-fromMe, @lid/@s.whatsapp.net, reply_to_bot)
        ▼
[GroupAdminResolver] (WA groupMetadata + cache + BOT_OWNER_NUMBERS -> admin | member)
        ▼
[TieredRateLimiter] (In-flight lock + Tiered cooldown -> drop / throttled ⏳ jika kena limit)
        ▼
[Sanitizer & MemoryContextService] (12 pesan terakhir + Bond Rank + Trivia aman)
        ▼
[AigisBrain (Gemini 3.5/3.1 / Groq)] ─▶ [sendQuotedReply (composing + quoted)] ─▶ [Simpan balasan bot]
```

```text
backend/
├── .env.example                       # Template seluruh variabel konfigurasi
├── .gitignore                         # Mengabaikan .env, auth_info/, data/, *.db, dist/, node_modules/
├── package.json
├── tsconfig.json
├── assets/
│   └── lore/
│       └── community_seed.example.json # Template seed trivia komunitas (data dummy)
├── auth_info/                         # [GITIGNORED] Kredensial sesi WhatsApp Multi-Device
├── data/                              # [GITIGNORED] SQLite DB (aigis.db) & community_seed.local.json
├── src/
│   ├── index.ts                       # Entry point aplikasi, pipeline guard/memory/brain, & shutdown
│   ├── cli-sandbox.ts                 # Simulator terminal interaktif tanpa koneksi WhatsApp
│   ├── config/                        # env.ts (validasi konfigurasi) & logger.ts (Pino)
│   ├── whatsapp/                      # client.ts (Baileys), router.ts (@lid), dispatcher.ts, types.ts
│   ├── brain/                         # intent, persona, promptBuilder, newsGrounder, communityLore, llmClient
│   ├── memory/                        # database, communitySeed, groupBufferRepo, memberMemoryRepo, contextService
│   └── guards/                        # types, adminResolver, rateLimiter, sanitize
└── tests/                             # Unit tests (brain, config, guards, memory, router)
```

---

## 4. Prasyarat & Setup Lokal

### Prasyarat
* **Node.js `v22.0.0+`** *(wajib untuk modul built-in `node:sqlite`)*
* **Nomor WhatsApp sekunder** khusus bot *(jangan memakai nomor WhatsApp pribadi utama)*
* **Google Gemini API Key** dari Google AI Studio (Free Tier)

### Langkah Instalasi & Menjalankan Bot
1. Salin `.env.example` menjadi `.env` lalu isi minimal `GEMINI_API_KEY`:
   ```powershell
   Copy-Item .env.example .env
   ```
2. *(Opsional)* Untuk mengisi database trivia founder/admin lokal tanpa masuk ke Git, salin template seed ke `data/community_seed.local.json` (folder `data/` sudah masuk `.gitignore`):
   ```powershell
   New-Item -ItemType Directory -Force data | Out-Null
   Copy-Item assets/lore/community_seed.example.json data/community_seed.local.json
   ```
3. Install dependencies, lalu jalankan typecheck, unit tests, dan build:
   ```powershell
   npm install
   npm run typecheck
   npm test
   npm run build
   ```
4. **Uji Offline dulu di CLI Sandbox** *(tanpa perlu login WhatsApp)*:
   ```powershell
   npm run sandbox
   ```
   Perintah khusus di dalam sandbox:
   * `/chatter <Nama>: <pesan>` — simulasi obrolan anggota lain di grup sebelum `@Aigis` dipanggil
   * `/quote <teks>` — simulasi me-*reply* pesan orang lain pada giliran berikutnya
   * `/history` — cek isi *sliding window* dan *Bond Rank* saat ini
   * `/darkhour` — toggle simulasi jam `00:15 WIB` (*Dark Hour*)
   * `/exit` — keluar dari sandbox
5. **Pairing WhatsApp Pertama Kali (Grup Uji Coba):**
   * Kosongkan `ALLOWED_GROUP_JIDS=` dulu untuk melihat daftar JID grup di log terminal (*Discovery Mode*), atau isi langsung JID grup tes sementara.
   * Jika memakai **Pairing Code** (berguna bila menautkan dari HP yang sama), isi `WA_PAIRING_PHONE=628xxxxxxxxxx` (tanpa `+`). Jika dikosongkan, terminal menampilkan **QR Code**.
   * Jalankan bot:
     ```powershell
     npm run dev
     ```
   * Setelah melihat JID grup tes di log, masukkan ke `ALLOWED_GROUP_JIDS=...` di `.env` lalu restart.

---

## 5. Daftar Variabel Lingkungan (`.env`)

| Variabel | Default | Keterangan |
| :--- | :--- | :--- |
| `NODE_ENV` | `development` | Mode runtime (`development` / `production` / `test`). |
| `LOG_LEVEL` | `info` | Level log Pino (`trace`, `debug`, `info`, `warn`, `error`). |
| `WA_AUTH_DIR` | `auth_info` | Folder penyimpan sesi Multi-Device Baileys *(gitignored)*. |
| `WA_PAIRING_PHONE` | *(kosong)* | Nomor bot (`628...`) untuk login Pairing Code; kosongkan untuk QR Code. |
| `ALLOWED_GROUP_JIDS` | *(kosong)* | Daftar JID grup whitelist dipisahkan koma (`120363xxx@g.us`). |
| `BOT_OWNER_NUMBERS` | *(kosong)* | Fallback nomor owner (`628...`) untuk status Pro Tier selain deteksi Admin Grup. |
| `GEMINI_API_KEY` | *(wajib)* | API Key Google AI Studio untuk LLM brain. |
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` | Model utama Gemini Free Tier. |
| `GEMINI_FALLBACK_MODELS` | `gemini-3.1-flash-lite` | Daftar model cadangan dipisahkan koma. |
| `GEMINI_TIMEOUT_MS` | `10000` | Timeout per request Gemini (ms). |
| `GROQ_API_KEY` / `GROQ_MODEL` | `llama-3.3-70b-versatile` | Fallback opsional jika seluruh model Gemini tidak tersedia. |
| `ENABLE_SEARCH_GROUNDING` | `false` | Disarankan `false` di Free Tier (memakai RSS gratis tanpa limit `429`). |
| `NEWS_FEED_CACHE_TTL_MS` | `900000` | Cache feed RSS ATLUS (15 menit). |
| `DB_PATH` | `data/aigis.db` | Lokasi database SQLite (`node:sqlite`). |
| `GROUP_CONTEXT_WINDOW_SIZE` | `12` | Jumlah pesan terakhir per grup yang disuntikkan ke prompt. |
| `GROUP_MESSAGE_RETENTION_LIMIT` | `100` | Batas maksimum riwayat pesan per grup sebelum di-prune. |
| `COMMUNITY_SEED_PATH` | `data/community_seed.local.json` | Path file seed JSON lokal opsional untuk `community_trivia`. |
| `USER_COOLDOWN_MS` | `15000` | Cooldown per-user untuk Member biasa (*Free Tier*). |
| `GROUP_COOLDOWN_MS` | `5000` | Cooldown global per-grup untuk Member biasa. |
| `ADMIN_COOLDOWN_MS` | `4000` | Cooldown cepat per-user untuk Admin Grup (*Pro Tier*). |
| `ADMIN_GROUP_COOLDOWN_MS` | `2000` | Cooldown global per-grup untuk Admin Grup. |
| `COOLDOWN_REACT_EMOJI` | `⏳` | Emoji reaksi saat rate-limited (isi `none` untuk silent drop murni). |
| `GROUP_METADATA_CACHE_TTL_MS` | `300000` | TTL cache metadata Admin Grup (5 menit; auto-invalidate saat ada perubahan admin). |
| `MAX_PROMPT_CHARS` / `MAX_QUOTED_CHARS` | `1500` / `1000` | Batas karakter maksimum input sanitizer untuk pesan utama & kutipan. |

---

## 6. Perintah `npm` yang Tersedia

* `npm run dev` — Menjalankan bot dengan `tsx watch` untuk pengembangan lokal.
* `npm run sandbox` — Menjalankan simulator chat terminal interaktif dengan SQLite in-memory.
* `npm run typecheck` — Pemeriksaan tipe TypeScript ketat (`tsc --noEmit`).
* `npm test` — Menjalankan seluruh unit test (`tsx --test "tests/**/*.test.ts"`).
* `npm run build` — Mengompilasi TypeScript ke folder `dist/`.
* `npm start` — Menjalankan hasil kompilasi produksi (`node dist/index.js`).

---

## 7. Standar Keamanan, Anti-Ban & Deploy 24/7

1. **Nomor Sekunder Wajib:** Jangan jalankan bot dengan nomor pribadi utama.
2. **Jangan Commit Rahasia:** Pastikan `.env`, `auth_info/`, `data/*.db`, dan `data/community_seed.local.json` tidak pernah masuk ke Git.
3. **Aturan Single-Session (`440 Connection Replaced`):** Satu folder `auth_info/` hanya boleh dijalankan pada **satu mesin aktif pada satu waktu**. Jika menjalankan bot di VPS (`npm run build && npm start` dengan `pm2` / `tmux`), pastikan proses bot di PC lokal sudah dimatikan terlebih dahulu.
4. **Target Host:** Membutuhkan Node.js `v22+` (berjalan di Windows lokal, Linux VPS via `pm2`, maupun Android Termux unrooted tanpa memerlukan Docker atau native C++ compiler).

---

## 8. Roadmap Pasca-`v0.1.0`

* **Modul 5:** 2-Stage Group Auto-Moderation (filter lokal phishing/spam link + evaluasi konteks/NSFW & *auto-delete* dalam mode Admin Grup).
* **Modul 6 (`v0.2.0`):** Konfigurasi deployment 24/7 resmi (`Dockerfile` / `docker-compose.yml` untuk VPS & setup `pm2` untuk MiniServer).
* **Modul 7 (`v0.3.0`):** Fun commands (`!arcana`, `!aigis status`), stiker WebP ekspresi Aigis, serta REST/WS API untuk repositori `frontend/`.
