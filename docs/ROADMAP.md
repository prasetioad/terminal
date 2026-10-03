# Roadmap: Orderflow Terminal → Probability Engine → Bot Binance

> Dokumen hidup. Diperbarui setiap tahap selesai atau ada hasil riset baru.
> Terakhir diperbarui: 2026-10-03 (Tahap 1 selesai).

## 1. Tujuan

**Tujuan akhir:** sistem yang untuk pair mana pun, kapan pun, menjawab:

1. **Kondisi pasar** sekarang apa (trending/range, volatil/sepi, siapa yang terjebak)?
2. **Setup** apa yang sedang aktif?
3. **Statistiknya** seberapa bagus di kondisi ini? Win rate, expectancy, jumlah sampel, diukur di data out-of-sample, setelah biaya.
4. **Rencana trade**: entry, stop, exit, dan ukuran posisi.

Lalu **bot** yang mengeksekusi setup yang sudah terbukti, otomatis di Binance, dengan manajemen risiko ketat.

**Gaya trading pemilik:** intraday sampai swing, kadang scalping. Semua pair yang berpotensi. Sekarang alat bantu keputusan; tujuan akhirnya bot otomatis. Siap menjalankan server 24/7.

## 2. Prinsip yang tidak boleh dilanggar

1. **Satu kode untuk semua.** Detektor dan aturan setup yang diuji di backtest adalah kode yang sama persis yang memberi sinyal live dan yang dieksekusi bot.
2. **Hipotesis dulu, uji dulu, baru bangun.** Aturan ditetapkan sebelum melihat hasil. Selalu ada data in-sample dan out-of-sample. Biaya, slippage, dan funding selalu dihitung.
3. **Syarat lulus sebelum naik tahap** (lihat bagian 6). Ide yang gagal uji tidak dipakai, sebagus apa pun kelihatannya di chart.
4. **Risiko lebih dulu daripada return.** Ukuran posisi berbasis risiko, stop bencana, batas rugi harian, kill switch.
5. **Keamanan.** API key hanya di server, izin trade saja (tanpa withdraw), dengan whitelist IP. Tidak pernah di browser atau di repo.
6. **Kejujuran statistik.** Hasil dilaporkan apa adanya, termasuk yang gagal. Survivorship bias, overfitting, dan multiple testing selalu disebut.

## 3. Status saat ini (sudah ada di app)

- Chart Binance spot (1m–1D), big trades multi-exchange (9 sumber, spot + perp), taker pressure (large vs market vs rest).
- Liquidity heatmap global order book dengan riwayat (IndexedDB, bisa dimigrasi).
- Indikator: Volume, Delta, CVD, Volume Profile, VWAP, Sessions, MaxFlow+ Ultimate, MaxFlow+ OF (eksperimen orderflow).
- Drawing: trend line, garis horizontal, rectangle, fib, fixed range volume profile (seperti TradingView), orderflow profile, long/short position dengan sizing dan P&L, measure, undo/redo.
- 477 pair Binance USDT, ranking CMC.

## 4. Hasil riset sejauh ini

### 4.1 MaxFlow+ Ultimate (osilator WaveTrend)
- Sinyal titik saja di 5m/15m/1h: **tidak punya keunggulan** di out-of-sample (hampir setara lempar koin).
- "Money flow" aslinya adalah RSI dari harga×volume. Hanya **54%** searah dengan taker delta sebenarnya, karena naik setiap kali volume melonjak, termasuk saat penjual dominan.
- Titik digambar 1 bar lebih awal dan divergence terkonfirmasi 5 bar kemudian. Akibatnya chart lama terlihat lebih akurat daripada saat live.

### 4.2 MaxFlow+ OF (clone dengan orderflow asli)
- Filter **spot-led** memperbaiki hasil asli di 6/6 sel uji. **Absorption** di 5/6. **Flow momentum merusak.** Belum ada yang signifikan (|t| < 2).
- Spot-led **melewatkan capitulation** (contoh COTI 30 Sep 19:15: spot −62%, lalu harga +205bp).

### 4.3 Konfluensi mekanis di 1h/4h/1D (25 pair, 2021–2026)
- Kombinasi yang dipilih dari data awal (support, OI, funding, sentimen, kapitulasi, dan lainnya) terlihat bagus di data awal (win 46–51%), lalu **gagal** di out-of-sample.
- **Temuan yang konsisten** di kedua periode:
  - Hindari sinyal melawan tren di 4h.
  - Hindari hari setelah BTC bergerak ≥ 5%.
  - Entry tepat di swing yang jelas cenderung buruk (stop di balik level yang jelas rawan kena sweep).
  - Di 1D, sinyal saat OI naik lebih baik.

### 4.4 Setup v1: metode pemilik (TERBUKTI, kandidat pertama)
**Aturan:** 4h, **long only**. Titik hijau MaxFlow (paling lama 5 bar sebelumnya), lalu Stochastic cross ke atas dari bawah 20, lalu entry di close bar. **Stop bencana −15%.** **Exit di cross bearish WaveTrend pertama di atas nol** (titik merah pertama).

| Uji | Hasil |
|---|---|
| 25 pair, Stoch 14,3,3, tanpa stop | 427 trade · win 62% · +2,07%/trade (t=4,7) · positif setiap tahun 2021–2026 · 22/25 pair positif |
| Stop −15% (25 pair) | Periode ujian +2,49%/trade, trade terburuk −15% (sebelumnya −42%) |
| 99 pair, Stoch 14,3,3 | Awal +0,93% (t=1,7) · ujian +2,10% (t=5,1) · 6/6 tahun positif · portofolio ujian +27,7%/thn, DD −12% |
| 99 pair, **Stoch 5,3,3** | Awal +2,02% (t=2,5) · ujian +1,74% (t=2,7) · paling konsisten · portofolio ujian +14,5%/thn, DD −10% |
| 99 pair, **Stoch "either"** (5,3,3 ATAU 14,3,3) | Awal +1,12% (t=2,0) · ujian +2,10% (t=5,1) · 6/6 tahun positif · 63/97 pair · portofolio ujian +28%/thn, DD −11,6% · **lulus t ≥ 2 di kedua periode, sinyal terbanyak → default scanner** |
| Funding (perp) | Pengaruhnya hanya −0,02 s.d. −0,06% per trade |

- **TP yang lebih maksimal tidak lebih baik.** Titik merah kedua, titik merah besar, trailing chandelier, dan target +4/+6 ATR semuanya lebih buruk. Titik merah pertama tetap terbaik. Satu-satunya alternatif yang masih wajar: trailing low 10 bar setelah titik merah pertama.
- **Stop ketat (< 3 ATR) merusak setup.** Setup ini mean reversion dan butuh ruang.
- **Short tidak punya keunggulan.** Support dan estimasi liquidation map belum terbukti menambah hasil.
- **Peringatan:** semesta 99 pair adalah top 100 hari ini (survivorship bias). Return portofolio harus dianggap **batas atas**.
- **Konfigurasi v1:** risiko 1% akun per trade (posisi sekitar 6,7% akun dengan stop −15%), maksimal 15 posisi bersamaan.

## 5. Roadmap

Setiap tahap punya hasil yang bisa langsung dipakai dan syarat lulus.

### Tahap 1: Setup v1 di app (alat bantu) ✅ SELESAI (2026-10-03)
- [x] Engine setup bersama `lib/setups/setupV1.ts` (satu kode untuk riset, chart, scanner, dan nanti bot).
- [x] Overlay chart (indikator "Setup v1", kategori Setups): panah entry, garis stop −15%, exit dengan hasil %, posisi terbuka, dan skor di legend.
- [x] Scanner 4h untuk 484 pair (`/api/setups/scan`, `components/SetupScanner.tsx`): entry baru, exit, dan posisi terbuka; filter volume dan stochastic; klik baris membuka pair di 4h dengan overlay.
- [x] Notifikasi browser untuk entry baru; badge jumlah entry yang belum dilihat di tombol Scanner.
- **Lulus:**
  - Engine app identik dengan riset: **1.694/1.694 trade**.
  - Scanner (jendela 500 bar) identik dengan riwayat penuh: **8.069/8.069 titik scan**, 2.612/2.612 trade.
  - Scan penuh 484 pair sekitar 21 detik, 0 gagal, sekitar 970 weight Binance per scan.
- **Pelajaran:** batas rate Binance per IP dipakai bersama oleh chart, scanner, dan nanti bot. Scan memakai `fetchKlinesBulk` (satu host, konkurensi 4, membaca `x-mbx-used-weight-1m`, menghormati `Retry-After`). Bot harus punya anggaran weight sendiri (Tahap 5).

### Tahap 2: Research Lab di repo
- [ ] Pindahkan script riset dari folder sementara ke `research/` supaya bisa dijalankan ulang.
- [x] Uji gabungan Stoch 5,3,3 OR 14,3,3 (lulus, lihat 4.4).
- [ ] Semesta tanpa survivorship bias: pair yang sudah di-delist (arsip data.binance.vision) dan peringkat per tanggal.
- [ ] Walk-forward berlapis, bootstrap confidence interval, dan monte carlo drawdown.
- **Lulus:** Setup v1 tetap positif di semesta tanpa bias.

### Tahap 3: Fondasi server (VPS Singapura)
- [ ] VPS 24/7 (Singapura/Tokyo, dekat exchange, bebas blokir DNS ISP).
- [ ] Collector: trade semua venue, bar buy/sell, order book untuk Tier A, OI, funding, likuidasi.
- [ ] Database time-series (ClickHouse), dengan pemantau kualitas data (celah, keterlambatan).
- [ ] Scanner pindah ke server, alert Telegram.
- [ ] Web app menjadi tampilan dari server (API + WebSocket).
- **Lulus:** 2 minggu data tanpa celah besar, alert Telegram tepat waktu.

### Tahap 4: Paper trading (bot tanpa uang)
- [ ] Engine eksekusi simulasi: entry di close 4h, stop, exit sinyal, fee dan slippage realistis.
- [ ] Jurnal otomatis: setiap trade dengan konteksnya. Dashboard performa live vs backtest.
- [ ] Mesin risiko: risiko per trade, maksimal posisi, eksposur per koin/sektor, batas rugi harian dan mingguan.
- **Lulus:** minimal 1–3 bulan atau ≥ 40 trade. Win rate dan expectancy dalam interval kepercayaan backtest. Tidak ada bug eksekusi.

### Tahap 5: Koneksi Binance, testnet lalu live kecil
- [ ] **Pilih pasar:** Setup v1 long-only, jadi mulai di **Spot** (tanpa likuidasi dan funding). Futures nanti untuk short dan leverage.
- [ ] API key: izin trade saja, tanpa withdraw, whitelist IP server, disimpan terenkripsi di server.
- [ ] Order manager: entry, stop dipasang di exchange (stop-limit / OCO di spot), exit, cek ulang posisi exchange vs internal setiap menit, order idempotent (clientOrderId), retry dan rate limit.
- [ ] **Binance Testnet** dulu (spot testnet / futures testnet) sampai semua skenario lulus: fill, partial fill, stop, disconnect, restart.
- [ ] Live dengan modal kecil dan risiko 0,25–0,5% per trade. Naik bertahap kalau metrik tetap sehat.
- **Lulus:** 1 bulan live tanpa selisih rekonsiliasi, slippage sesuai asumsi.

### Tahap 6: Operasi dan keamanan bot
- [ ] Kill switch (manual dan otomatis), batas rugi harian/mingguan, berhenti otomatis kalau data rusak.
- [ ] Monitoring: health check, alert Telegram saat error, log audit setiap keputusan.
- [ ] Pemantauan pemudaran keunggulan: kalau performa live turun di bawah ambang, setup otomatis dinonaktifkan.

### Tahap 7: Lapisan data posisi
- [ ] OI, funding, likuidasi live, basis, Coinbase premium, kuadran harga×OI, perkiraan peta likuidasi.

### Tahap 8: Skala, setup dan kecerdasan tambahan
- [ ] Detektor orderflow: absorption, exhaustion/capitulation, initiative breakout, spot/perp divergence, sweep. Masing-masing diuji di Research Lab.
- [ ] Klasifikasi kondisi pasar dan meta-labeling (ML memilih sinyal mana yang diambil, bukan menebak harga).
- [ ] Integrasi jurnal manual untuk mengukur keunggulan pribadi.
- [ ] Portofolio multi-setup dengan alokasi risiko.

## 6. Syarat lulus setup (berlaku untuk semua setup)

- **Sampel:** ≥ 100 kejadian out-of-sample, ≥ 30 per kelompok yang dilaporkan.
- **Setelah biaya:** expectancy positif setelah fee, spread, slippage, dan funding, dengan margin aman.
- **Konsisten:** positif di ≥ 2/3 periode walk-forward dan di beberapa kelompok pair.
- **Signifikan:** t ≥ 2 atau interval kepercayaan bootstrap tidak mencakup nol.
- **Dipantau live:** dinonaktifkan otomatis kalau performa turun di bawah ambang.

## 7. Arsitektur target

```
Exchange (Binance, Bybit, OKX, Coinbase, KuCoin, Deribit)
      │ WebSocket + REST
      ▼
[Collector 24/7, VPS] ──► [ClickHouse] ──► [Engine: fitur + detektor + setup]  ← satu kode
                                               ├─► Research Lab (backtest, walk-forward)
                                               ├─► Scanner → Web app + Telegram
                                               ├─► Paper trading + jurnal
                                               └─► Bot: mesin risiko → order manager → Binance API
```

## 8. Risiko dan cara mengatasinya

| Risiko | Cara mengatasi |
|---|---|
| Overfitting / multiple testing | Aturan ditetapkan di depan, out-of-sample, walk-forward, syarat lulus |
| Survivorship bias | Semesta tanpa bias (Tahap 2) sebelum bot live |
| Kondisi pasar berubah | Statistik per kondisi, pemantauan live, nonaktif otomatis |
| Slippage dan likuiditas altcoin | Biaya di semua uji, filter likuiditas minimum, ukuran posisi dibatasi likuiditas |
| Bug bot / rekonsiliasi | Testnet, order idempotent, cek ulang posisi, kill switch |
| Keamanan API key | Trade-only, tanpa withdraw, whitelist IP, terenkripsi, hanya di server |
| Data bolong / API berubah | Pemantau kualitas data, bot berhenti otomatis saat data tidak valid |

## 9. Keputusan terbuka

- Provider VPS (rekomendasi: Hetzner/Vultr/DigitalOcean, Singapura).
- Stoch 5,3,3 vs 14,3,3 vs gabungan (menunggu uji Tahap 2).
- Pasar bot pertama: Spot (rekomendasi untuk Setup v1) atau Futures.
- Saluran alert: Telegram.

## 10. Catatan perubahan

- **2026-10-03:** Roadmap dibuat. Setup v1 ditetapkan dari riset 25 dan 99 pair. Mulai Tahap 1.
- **2026-10-03:** Tahap 1 selesai (engine, overlay, scanner, notifikasi). Uji Stoch gabungan: "either" lulus kedua periode dan dijadikan default. Berikutnya: Tahap 2 (Research Lab di repo, semesta tanpa survivorship bias).
