# Bot Setup v1 + Setup A: panduan

Bot ini menjalankan **Setup v1** (MaxFlow+ × Stoch long, 4h) secara otomatis di Binance Spot, memakai **engine yang sama persis** dengan riset, chart, dan scanner (`lib/setups/setupV1.ts`). Latar belakang dan hasil riset ada di [ROADMAP.md](ROADMAP.md).

> **Peringatan.** Hasil backtest tidak menjamin hasil di masa depan. Mulai di **paper**, lalu **testnet**, lalu **live dengan risiko kecil**, dan naik tahap hanya kalau syarat di bagian 6 terpenuhi. Jangan pernah memakai uang yang tidak siap hilang.

## 1. Cara kerja

```
setiap candle 4h tutup (+90 detik)
  ├─ evaluasi semua pair USDT dengan engine Setup v1
  ├─ posisi terbuka: exit kalau setup menutupnya
  │    · sinyal (titik merah pertama) → jual market
  │    · stop −15% → di exchange: order stop yang sudah terpasang · di paper: dari bar
  ├─ entry baru (sinyal di bar ini saja, urut dari yang paling likuid)
  │    · lewat gerbang risiko: pause, batas rugi harian, maks posisi, volume 24h, aturan exchange
  │    · beli market → pasang stop −15% di exchange (gagal pasang stop → posisi langsung dijual lagi)
  └─ catat equity; kirim ringkasan ke Telegram

setiap menit (testnet/live): cek stop yang terisi dan posisi yang dijual manual
```

- **Idempoten:** satu sinyal (pair + bar) hanya dieksekusi sekali. Setiap order punya client id tetap. Kalau request terputus, bot mencari ordernya dulu sebelum mencoba lagi, jadi tidak ada beli ganda. Restart di tengah siklus aman.
- **Ukuran posisi:** `risiko × equity ÷ 15%`. Risiko 1% berarti posisi 6,7% dari equity, dibatasi `MAX_POSITION_FRACTION` dan kas yang tersedia.
- **P&L** dihitung dari arus kas aktual (USDT keluar dan masuk, sudah termasuk fee), bukan dari harga teoretis.
- **Entry yang terlewat tidak dikejar.** Kalau bot mati saat sebuah sinyal muncul, sinyal itu dilewatkan. Sesuai backtest, hanya entry di close bar sinyal yang diambil.

## 1b. Beberapa setup dalam satu akun (v1.2 + Setup A)

Bot bisa menjalankan **Setup v1** (kapitulasi) dan **Setup A** (breakout) bersamaan dengan modal bersama, sesuai hasil riset di [ROADMAP.md §4.10](ROADMAP.md).

| Variabel | Arti | Default |
|---|---|---|
| `SETUPS` | `v1`, `a`, atau `v1,a` | `v1` |
| `MAX_RISK_PER_BAR` | v1.2: total risiko entry v1 dalam satu candle, misalnya `0.05` (maksimal 5 posisi 1%) | `0` (mati, v1.1) |
| `RISK_PER_TRADE_A` | Risiko per trade Setup A di stop 8×ATR (sekitar 20% → posisi sekitar 2,5%) | `0.005` |
| `MAX_OPEN_POSITIONS_A` | Batas posisi Setup A | `15` |
| `V1_FIRST_DOT_ONLY` | §4.12: v1 hanya di titik hijau pertama dalam satu penurunan (titik hijau berikutnya dalam 30 candle dilewati) | `0` (mati) |
| `A_MAX_RS` | §4.12: Setup A hanya untuk koin yang return 30 harinya tertinggal dari BTC lebih dari nilai ini, misalnya `-0.1` | kosong (mati) |
| `MIN_SIZE_MAX_RISK` | Akun kecil: kalau ukuran berbasis risiko di bawah minimal order, ambil ukuran valid terkecil (≈ $7) asal kerugiannya di stop ≤ nilai ini dari modal, misalnya `0.015` | `0` (mati) |
| `A_SPIKE_TIGHTEN` | §4.16: trailing Setup A dirapatkan ke 4×ATR setelah candle hijau setinggi ≥ 3×ATR saat posisi profit | `0` (mati) |

- Satu pair hanya punya satu posisi, dari setup mana pun. Kandidat kedua setup diurutkan dari yang paling likuid, seperti di riset. Setup A maksimal 5 entry per candle.
- **Exit Setup A:** stop awal 8×ATR dipasang di exchange, lalu trailing (close tertinggi − 8×ATR) dicek di setiap close 4h dan dijual market kalau tertembus.
- Order id Setup A memakai prefix `sva-`, sedangkan v1 tetap `sv1-`.
- Filter RS membutuhkan candle BTCUSDT di setiap siklus. Kalau BTC gagal diambil, entry Setup A di siklus itu dilewati (dan dicatat sebagai error). Posisi yang sudah ada tetap dikelola. Breakout yang tidak lolos filter tetap "menempati" pair, persis seperti di riset.
- Posisi v1 yang dibuka sebelum `V1_FIRST_DOT_ONLY` dinyalakan tetap dikelola dengan aturan saat posisi itu dibuka.
- **Modal minimum:** posisi Setup A sekitar 2,5% modal, dan stop-nya harus tetap ≥ minimal order Binance ($5, plus margin 10%). Di bawah sekitar $300, sebagian sinyal Setup A dilewati dengan alasan "below the exchange minimum".
- **Eksperimen lokal:** `npm run bot:local` membaca `bot/.env.local` (v1.2 + A, paper $300, DB `bot/data/combined.sqlite`, tanpa Telegram karena token Telegram dipakai bot VPS).
- `npm run bot:replay -- --days 365` menguji fidelity per setup. Hasil wajib: missing 0 · extra 0 · exit mismatches 0.

## 2. Menjalankan secara lokal (paper)

```bash
cp bot/.env.example bot/.env      # MODE=paper sudah default
npm run bot                       # bot berjalan; Ctrl+C untuk berhenti
npm run dev                       # web app → tombol "Bot" di toolbar chart
```

Uji dan validasi:

```bash
npm run bot:test                  # unit test (exchange di-mock)
npm run bot:replay -- --days 365  # jalankan bot di atas data historis lewat kode yang sama dengan live
npm run research:setup-v1         # backtest tanpa survivorship bias (semua pair, termasuk yang di-delist)
```

`bot:replay` harus menunjukkan **missing 0 · extra 0 · exit mismatches 0**. Artinya bot mengeksekusi persis trade yang sudah diuji di backtest.

## 3. Telegram (disarankan)

1. Di Telegram, buka **@BotFather**, kirim `/newbot`, lalu salin tokennya ke `TELEGRAM_BOT_TOKEN`.
2. Kirim pesan apa saja ke bot barumu. Buka `https://api.telegram.org/bot<TOKEN>/getUpdates`, lalu salin `chat.id` ke `TELEGRAM_CHAT_ID`.
3. Restart bot. Perintah yang tersedia (hanya dari chat ID tersebut):

| Perintah | Fungsi |
|---|---|
| `/status` | Mode, equity, posisi, hasil, siklus berikutnya |
| `/report` | Laporan harian sekarang (juga dikirim otomatis setiap hari 01:00 UTC = 08:00 WIB; ubah dengan `REPORT_UTC_HOUR`) |
| `/positions` | Posisi terbuka |
| `/pause` · `/resume` | Hentikan / lanjutkan entry baru (posisi yang ada tetap dikelola) |
| `/flatten CONFIRM` | **Kill switch:** jual semua posisi di market dan pause entry |

**Laporan harian** (setiap bot ke Telegram-nya sendiri): equity dan perubahan 24 jam, posisi terbuka beserta P&L, aktivitas 24 jam (entry, exit, P&L realisasi, jumlah siklus, error), peringatan Binance, dan (bot Ops) kesehatan collector. Masalah ditandai di baris atas: siklus kurang dari 5 dari 6, ada error, entry di-pause, pair yang dipegang mendapat peringatan Binance, collector berhenti. **Kalau laporan pukul 08:00 WIB tidak datang, ada yang mati.**

## 4. Binance Testnet

1. Buka https://testnet.binance.vision, login dengan GitHub, lalu **Generate HMAC_SHA256 Key**.
2. Di `bot/.env`: `MODE=testnet`, `BINANCE_API_KEY=…`, `BINANCE_API_SECRET=…`.
3. Cek jalur eksekusi dengan uang mainan: `npx tsx bot/testnet-check.ts BTCUSDT 15`. Script ini membeli, memasang stop −15% di exchange, membatalkannya, menjual kembali, lalu memastikan pembukuan bot cocok dengan saldo Binance.
4. **Skenario eksekusi lengkap:** `npm run bot:testnet-scenarios`. Sinyal sintetis, tapi order sungguhan di testnet lewat engine bot: entry Setup A dengan stop di exchange, restart di tengah posisi (tanpa beli ganda), exit trailing (stop dibatalkan lalu jual market), stop terisi di exchange (dicatat oleh reconcile), penjualan manual terdeteksi, `/pause` dan `/flatten`, serta koin milik akun yang memblokir entry. Hasil wajib: `ALL TESTNET SCENARIOS PASSED`. Lulus 2026-10-05.
5. **Peringatan Binance (delisting, Monitoring):** setiap siklus bot membaca jadwal delisting spot resmi (`/sapi/v1/spot/delist-schedule`, butuh key live; tanpa key: dari judul pengumuman "Binance Will Delist …", hanya delisting token) dan tag Monitoring (data produk publik Binance), diperbarui setiap jam. Pair yang akan di-delist atau bertag Monitoring tidak di-entry. Posisi di pair yang diumumkan akan di-delist **dijual di siklus berikutnya** (alasan exit `delist`). Tag Monitoring pada posisi terbuka hanya memicu satu peringatan 🚩 di Telegram. Scanner menampilkan label DELIST/MONITORING (dari sumber publik).
6. **Stop yang hilang tanpa terisi:** setiap menit bot memeriksa status stop di exchange. Kalau stop dibatalkan (manual di app Binance, atau oleh Binance saat maintenance/delisting), kedaluwarsa, ditolak, atau tidak ditemukan: (a) kalau sempat terisi sebagian, sisa koin dijual market dan posisi dibukukan sebagai satu exit stop; (b) kalau tidak terisi dan harga masih di atas stop, stop dipasang ulang dan dikirim peringatan 🚩; (c) kalau harga sudah di bawah stop, atau stop tidak bisa dipasang ulang, posisi dijual market. Posisi tidak pernah dibiarkan tanpa stop.
7. **Koin di luar bot:** di testnet/live, bot tidak entry di pair yang koinnya sudah ada di akun (nilai > $1). Dengan begitu koin pribadimu tidak tercampur dengan posisi bot, penjualan manual tetap terdeteksi, dan exit tidak pernah menjual koinmu.
8. Testnet memakai saldo uji. **Pair dan harganya berbeda dari pasar sungguhan**, dan banyak altcoin tidak tersedia (bot akan melewatinya dengan alasan "not listed"). Tujuan testnet adalah menguji jalur eksekusi: order, stop, pembatalan, rekonsiliasi, dan restart. Testnet tidak cocok untuk menilai profit.

## 5. Live (uang sungguhan)

1. Buat API key di Binance (**API Management**):
   - ✅ *Enable Reading*, ✅ *Enable Spot & Margin Trading*.
   - ❌ **Withdrawals harus mati.** ❌ Futures dan Margin tidak perlu.
   - **Restrict access to trusted IPs:** isi dengan IP server (VPS).
2. Di `bot/.env`:
   ```
   MODE=live
   LIVE_CONFIRM=I_UNDERSTAND_THIS_TRADES_REAL_MONEY
   RISK_PER_TRADE=0.0025        # mulai kecil: 0,25% per trade
   ```
3. Siapkan saldo USDT di akun Spot. Bot hanya memakai USDT yang bebas, dan aset lain tidak disentuh.
4. Jangan trading manual di pair yang sedang dipegang bot. Kalau koinnya kamu jual sendiri, bot akan mencatatnya sebagai "manual".

## 6. Syarat naik tahap

| Dari → ke | Syarat |
|---|---|
| Paper → Testnet | `bot:test` dan `bot:replay` lulus (0 selisih). Paper berjalan ≥ 2 minggu tanpa error siklus. |
| Testnet → Live kecil | Semua skenario sukses di testnet: entry, stop terpasang, exit sinyal, stop terisi, restart di tengah posisi, `/pause`, `/flatten`. |
| Live kecil → normal | ≥ 40 trade live. Win rate dan rata-rata per trade dalam rentang backtest (sekitar 55–60%, +1–2% sebelum fee bot). Slippage sesuai asumsi. Tidak ada selisih rekonsiliasi. |

Kalau performa live jatuh jauh di bawah rentang backtest, `/pause` dan evaluasi ulang. Keunggulan di pasar bisa memudar.

## 7. Deploy ke VPS (Singapura disarankan)

Alasan memilih Singapura: dekat dengan server Binance, dan tidak terkena blokir DNS ISP Indonesia.

```bash
# Ubuntu 24.04, sebagai user non-root dengan sudo
sudo apt update && sudo apt install -y docker.io docker-compose-v2 git ufw
sudo ufw allow OpenSSH && sudo ufw enable          # jangan buka port 3000/8787 ke publik
git clone <repo> terminal && cd terminal && git checkout terminal-v3
cp bot/.env.example bot/.env && nano bot/.env       # isi mode, key, Telegram, API_TOKEN (wajib di Docker)
echo "API_TOKEN=<token yang sama dengan bot/.env>" > .env   # untuk container web (proxy panel Bot)
docker compose up -d --build
docker compose logs -f bot
```

- Web app hanya mendengarkan di `127.0.0.1:3000`. Akses dari laptop lewat tunnel SSH: `ssh -L 3000:127.0.0.1:3000 user@server`, lalu buka http://localhost:3000.
- **Backup:** salin `bot/data/bot.sqlite` secara berkala, misalnya dengan cron dan `sqlite3 bot.sqlite ".backup backup.sqlite"`.
- **Update:** `git pull && docker compose up -d --build`. Bot menyelesaikan siklus yang sedang berjalan sebelum berhenti.
- `API_TOKEN` wajib di Docker. Tanpa token, API bot hanya mendengarkan di localhost container, sehingga panel Bot tidak bisa menjangkaunya.

## 7b. Dua bot di VPS: paper (testing) dan ops (testnet lalu live)

| | Paper (`bot`) | Ops (`bot-ops`) |
|---|---|---|
| Pengaturan | `bot/.env` (`MODE=paper`) | `bot/.env.ops` (`MODE=testnet`, nanti `MODE=live` + `LIVE_CONFIRM`) |
| Database | `bot/data/bot.sqlite` | `bot/data/ops.sqlite` |
| Fungsi | Menguji perubahan dan varian tanpa uang | Menjalankan strategi yang sudah terbukti di exchange |
| Telegram | Bot Telegram kedua (kosongkan token kalau belum ada) | Bot Telegram utama |
| Menjalankan | `docker compose up -d --build` | `docker compose --profile ops up -d --build` |

- Satu token Telegram hanya untuk satu bot. Kalau dua bot memakai token yang sama, perintah dan pesan akan bentrok.
- `API_TOKEN` sama di kedua file (dan di `.env` root untuk container web). Panel Bot di web punya pilihan **Paper / Ops**.
- **Ke live:** buat API key live (Spot only, withdrawal mati, dibatasi ke IP VPS), isi saldo USDT di akun Spot, lalu di `bot/.env.ops` set `MODE=live`, `LIVE_CONFIRM=I_UNDERSTAND_THIS_TRADES_REAL_MONEY`, dan ganti `BINANCE_API_KEY`/`BINANCE_API_SECRET` dengan key live. Kunci tidak pernah dikirim lewat chat: tulis di file lokal yang di-ignore, lalu salin hanya baris itu ke server.
- Jangan trading manual di koin yang sedang dipegang bot ops. Bot hanya memakai USDT yang bebas.

## 7c. Collector data pasar (likuidasi dan orderbook)

Container `collector` merekam data yang tidak tersedia di arsip Binance, untuk riset nanti (Tahap 7 F6). Hanya data publik, tanpa key.

| Data | Sumber | Isi |
|---|---|---|
| Likuidasi | Stream futures `!forceOrder@arr` (semua kontrak USDT-M) | waktu, pair, sisi (long/short yang dilikuidasi), harga, jumlah, nilai USDT. Binance mengirim paling banyak 1 per pair per detik, sehingga kaskade tercatat sebagian |
| Orderbook | REST spot setiap menit, 40 pair paling likuid (5000 level untuk 4 teratas, 500 untuk lainnya) | mid, spread, USDT di bid/ask dalam ±0,25 / 0,5 / 1 / 2 / 5%, jangkauan level |

- File: `collector/data/collector-YYYY-MM.sqlite` (satu per bulan), perkiraan ±25–45 MB per hari.
- Log ringkasan setiap jam: `docker compose logs collector`.
- Collector berhenti mengambil orderbook untuk sisa menit itu kalau weight API IP di atas 3.000/menit, supaya bot tetap aman.
- **Tidak ada backup otomatis** (data tidak bisa diunduh ulang). Salin bulan yang sudah selesai ke laptop secara berkala.

## 8. Konfigurasi

Semua pengaturan ada di [bot/.env.example](../bot/.env.example), lengkap dengan penjelasan. Nilai di luar batas aman ditolak saat start (misalnya risiko per trade maksimal 5%).

## 9. Batas rate Binance

Chart, scanner, dan bot berbagi batas weight per IP (6.000/menit). Bot mengambil kline lewat `fetchKlinesBulk`: satu host, 4 permintaan bersamaan, melambat saat weight tinggi, dan menunggu sesuai `Retry-After` saat terkena 429. Satu siklus penuh memakan sekitar 1.000 weight.
