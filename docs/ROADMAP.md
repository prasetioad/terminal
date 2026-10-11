# Roadmap: Orderflow Terminal → Probability Engine → Bot Binance

> Dokumen hidup. Diperbarui setiap tahap selesai atau ada hasil riset baru.
> Terakhir diperbarui: 2026-10-03 (Tahap 1–2 selesai; kode Tahap 3–6 selesai, menunggu VPS dan API key).

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

### 4.5 Uji tanpa survivorship bias → Setup v1.1 (TEMUAN PENTING)
`npm run research:setup-v1`: **653 pair USDT dari arsip Binance, termasuk yang sudah di-delist**, 2021–2026. Ada 579 pair dengan trade (5.570 trade). Likuiditas diukur pada waktu sinyal (rata-rata volume harian 30 hari).

- **Per trade, sinyalnya nyata:** periode awal +0,72% (t=2,8), periode ujian +1,70% (t=6,7). Koin yang di-delist juga positif (+1,21%).
- **Tapi portofolio Setup v1 rugi:** −7% sampai −10% per tahun, drawdown −48% sampai −58%.
- **Penyebab:** keunggulannya datang dari **kapitulasi seluruh pasar**. Rata-rata per trade menurut jumlah pair yang memberi sinyal di bar yang sama:

  | Pair yang memberi sinyal di bar yang sama | Rata-rata per trade |
  |---|---|
  | 1 pair (terisolasi) | −0,03% |
  | 2–4 pair | +0,25% |
  | 5–14 pair | +0,97% |
  | 15–39 pair | +2,36% |
  | 40+ pair | +3,16% |

  Portofolio berkapasitas 15 posisi terisi oleh sinyal terisolasi yang buruk, sehingga tidak ada slot tersisa saat kapitulasi (peluang terbaik) datang.
- **Setup v1.1 = Setup v1 + filter breadth ≥ 10 pair + likuiditas ≥ $1M/hari.** Ambang breadth dipilih **hanya dari data awal** (10 adalah yang terbaik di sana):

  | v1.1 (likuiditas ≥ $1M, breadth ≥ 10) | Periode awal | Periode ujian |
  |---|---|---|
  | Per trade | win 60% · +1,91% (t=4,3) | win 60% · **+3,56%** (t=7,6) · 95% CI [+2,71%, +4,56%] |
  | Portofolio (paling likuid dulu, ≤ 15 posisi, risiko 1%) | **+12,0%/thn**, DD −25% | **+12,1%/thn**, DD −12% |
  | Per tahun | 2021 +3,8% · 2022 +2,6% · 2023 +1,4% · 2024 +1,7% · 2025 +6,5% · 2026 −0,1% | |
  | Masih listing / sudah di-delist | +2,84% / **+2,53%** | |

- **Kejujuran:** efek breadth ditemukan dengan melihat seluruh data. Ambangnya dipilih dari data awal, tapi idenya sendiri sedikit terkontaminasi data ujian. **Paper trading ke depan adalah ujian yang sebenarnya.**
- **Frekuensi:** bar dengan ≥ 10 sinyal sekaligus hanya terjadi 106 kali dalam 5,8 tahun. Bot banyak diam, lalu bergerak saat pasar kapitulasi.
- **Catatan:** pada likuiditas ≥ $5M, periode awal lemah (+0,28%). Keunggulan di 2021–2024 lebih banyak di koin menengah. Nanti, perhatikan slippage di koin bervolume ~$1–5M/hari.

### 4.6 Upgrade v1.1: lebih banyak peluang, risiko lebih kecil? (riset lokal, BELUM di server)

`npx tsx research/variants.ts`. Portofolio seperti bot (compounding, mark-to-market setiap bar 4h), biaya 0,1% + slippage tambahan 0,2% untuk pair < $5M/hari. Parameter dipilih **hanya di in-sample** (2021-01 → 2024-06), lalu dicek out-of-sample (2024-07 → sekarang).

| Varian | IS CAGR / DD / Calmar | OOS CAGR / DD / Calmar | Putusan |
|---|---|---|---|
| v1.1 (bot sekarang): 1% × 15 | +11,4% / −26,8% / 0,43 | +11,2% / −19,9% / 0,56 | baseline |
| H1 breadth ≥ 5 / ≥ 7 | +4,5% / +9,0% | −3,1% / +4,1% | ❌ trade lebih banyak tapi jelek |
| H2 pilih drawdown terdalam / stoch terendah | 0,60 / 0,76 | 0,37 / 0,36 | ❌ bagus di IS, gagal OOS |
| H3 ukuran ikut breadth | 0,37 | 0,45 | ❌ |
| H4 0,33% × 45 slot | 0,87 | 0,62 | ➖ lebih baik dari baseline, kalah dari H5 |
| **H5 batas risiko per bar (1% × 15, ≤ 5% per bar)** | **+13,3% / −14,3% / 0,93** | **+12,2% / −11,2% / 1,09** | ✅ **kandidat v1.2** |
| H6 exit trailing setelah titik merah | 0,39 | 0,21 | ❌ |
| H7 hanya saat BTC di atas / di bawah MA200 | 0,10 / 0,58 | 1,07 / −0,29 | ❌ tidak konsisten (berbalik antar periode) |
| H8 breadth stoch saja, tanpa titik MaxFlow | −49% CAGR | −55% CAGR | ❌ titik MaxFlow wajib |

- **Temuan utama:** satu kapitulasi = satu taruhan yang saling berkorelasi. Membatasi total risiko per bar sinyal di **≤ 5% equity** (maks. 5 posisi 1%, yang paling likuid) menurunkan drawdown hampir separuh dan menaikkan win rate (OOS 54% → 61%, rata-rata +1,59% → +2,13%/trade) dengan profit yang sama. Plato parameter stabil: 0,5–1% per posisi dengan batas 3–5% per bar memberi Calmar IS 0,92–0,94 dan OOS 1,02–1,09.
- **Per tahun (v1.2 kandidat 0,5%/≤3% vs v1.1):** drawdown terburuk turun dari −35,6% (2024) menjadi −10,4%.
- **"Lebih banyak peluang" tidak terbukti:** setiap cara menambah jumlah trade (breadth lebih rendah, stoch saja, lebih banyak slot) menurunkan kualitas. Peluang setup ini memang jarang (±90 trade/tahun).
- **"Profit lebih tinggi" tidak bisa dengan menaikkan risiko:** 1,5%/≤7,5% dan 2%/≤10% memberi CAGR yang sama (~12%) dengan DD −17%. Batas per bar yang sama dengan posisi lebih besar = lebih sedikit pair = diversifikasi hilang. Modal rata-rata hanya terpakai 5–7%, jadi sisa modal bebas dipakai untuk hal lain.
- **Status:** belum diterapkan di bot. Butuh opsi `MAX_RISK_PER_BAR` di bot (default mati) kalau diputuskan.

### 4.7 Menangkap tren (kasus ZEC Agu → Okt 2026) dan strategi lain (riset lokal, BELUM di server)

`npx tsx research/momentum.ts` (1h butuh `npx tsx research/preload.ts 1h` sekali). Semesta dan portofolio sama dengan §4.6: 653 pair termasuk delisted, compounding, mark-to-market, biaya 0,1% + 0,2% untuk pair < $5M. Parameter dipilih di IS (2021-01 → 2024-06), OOS (2024-07 → sekarang) hanya dilaporkan. Sekitar 45 konfigurasi diuji, jadi sebagian hasil IS yang bagus pasti kebetulan. Yang dipercaya hanya yang positif di kedua periode.

**Kenapa v1.1 tidak menangkap ZEC:** v1.1 membeli kapitulasi seluruh pasar (breadth ≥ 10). ZEC naik sendirian, jadi breadth-nya selalu 1. Ini dua jenis peluang yang berbeda dan butuh setup yang berbeda.

| Strategi (4h kecuali D) | IS CAGR / DD / Calmar | OOS CAGR / DD / Calmar | ZEC | Putusan |
|---|---|---|---|---|
| v1.2 kandidat (kapitulasi) | +13,3% / −14,3% / 0,93 | +12,5% / −11,2% / 1,11 | tidak ada trade | dasar |
| **A breakout high 20 hari, stop & trailing 8×ATR** (risiko 0,5%) | +14,7% / −31,2% / 0,47 | +14,1% / −25,0% / 0,57 | **$551 → $1.323, +140% (masih open)** | ✅ positif di kedua periode, di semua varian filter |
| A + volume ≥ 1,5× rata-rata | 0,50 | 1,35 | sama | ✅ filter paling konsisten |
| A refined (RS<0 + volume ≥ 1,5× + F&G ≥ 25), pilihan IS | +14,5% / −20,6% / 0,70 | +7,8% / −15,6% / 0,50 | sama | ✅ (RS<0 melemah di OOS) |
| B metode pemilik saat koin uptrend (tanpa breadth) | +2,6% / 0,10 | +2,7% / 0,11 | −5,8% | ❌ terlalu tipis |
| C rotasi mingguan top-K gainer | −34% s/d +17% | −64% s/d −95% | +86% | ❌ membeli pump & dump (DEXE −92%, TUT −87%) |
| D metode pemilik di 1h | −13,3% | −22,6% | +8,8%, +2,5% | ❌ biaya memakan semua |
| D 1h + breadth ≥ 5/10/20 | 0,84–1,15 | ≈ 0 | | ❌ gagal OOS |
| D 1h hanya saat takut (BTC < 200D dan F&G < 50) | +4,1% / −16,0% / 0,26 | +11,2% / −12,6% / 0,88 | | ⚠️ positif tapi tipis (+0,2–0,3%/trade) dan rentan slippage |
| **Gabungan v1.2 + A refined** | +24,9% / −23,1% / 1,08 | +17,0% / −22,1% / 0,77 | +140% | ✅ positif setiap tahun 2021–2026 |
| Gabungan v1.2 + A refined + D takut | +29,8% / −26,2% / 1,14 | +27,6% / −21,2% / 1,30 | | ⚠️ terbaik di atas kertas; D rapuh |

- **Data apa yang membawa informasi** (rata-rata per trade per kelompok, konsisten IS dan OOS):
  - **Breakout:** paling bagus kalau koinnya *tertinggal* dari BTC 30 hari terakhir (RS < −10%: +18% IS, +9,9% OOS per trade), artinya keluar dari base. Paling jelek kalau sudah naik jauh (RS ≥ +20%: negatif di kedua periode). Volume di bawah rata-rata dan Fear & Greed < 25 juga jelek.
  - **Setup MaxFlow/stoch:** hanya membayar saat pasar takut (BTC di bawah MA200, F&G < 50). Saat serakah (F&G ≥ 75) negatif di kedua periode.
  - **Orderflow (taker buy dari kline):** tidak konsisten. Tidak dipakai.
- **Profil yang diminta:**
  - *win rate kecil tapi growth besar:* breakout A (win ~30–37%, rata-rata menang 3× rata-rata kalah).
  - *jarang trade tapi sekali dapat besar:* juga A. Trade rata-rata ditahan 18–23 hari, dan pemenang besarnya seperti ZEC.
  - *trade kecil tapi banyak:* tidak lulus (1h dimakan biaya).
- **Breakout dan kapitulasi saling melengkapi:** v1.2 kuat di 2022 dan 2025 saat A lemah, A kuat di 2023 dan 2024 saat v1.2 lemah. Gabungannya positif setiap tahun (+11% s/d +42%).
- **Open interest:** Binance tidak menyediakan riwayat OI lebih dari 30 hari (arsip harian per pair terlalu berat untuk 650 pair). Hanya bisa dikumpulkan ke depan oleh collector di VPS.
- **Status:** belum ada yang diterapkan di bot atau scanner. Kandidat berikutnya: Setup A (breakout) sebagai indikator dan scanner kedua di app, lalu paper.

### 4.8 Stochastic dilonggarkan: cross di bawah garis tengah juga valid (riset lokal)

`npx tsx research/stoch-level.ts`. Cross naik %K/%D dihitung valid kalau terjadi di bawah 20 (aturan sekarang), 30, 40, atau 50 (garis tengah). Engine mendapat opsi `stochLevel` (default 20, jadi chart, scanner, dan bot tidak berubah).

| Aturan (portofolio v1.2: breadth ≥ 10, ≤ 5% per bar) | IS CAGR / DD / Calmar | OOS CAGR / DD / Calmar | Trade/tahun |
|---|---|---|---|
| **stoch < 20 (sekarang)** | **+13,3% / −14,3% / 0,93** | +12,5% / −11,2% / 1,11 | 80–92 |
| stoch < 30 | +10,0% / −17,9% / 0,56 | +12,1% / −12,2% / 0,99 | 95–100 |
| stoch < 40 | +12,5% / −16,8% / 0,74 | +16,4% / −11,8% / 1,39 | 101–112 |
| stoch < 50 (garis tengah) | +12,5% / −17,2% / 0,73 | +15,9% / −11,8% / 1,35 | 104–111 |
| Hybrid: < 50 hanya saat BTC > 200D | +11,0% / −17,2% / 0,64 | +13,3% / −13,0% / 1,03 | |

- **Sinyal tambahan saja (cross di zona 20–50):** IS −0,27%/trade, OOS **+4,74%/trade** (win 69%). Per tahun: 2021 +0,7%, **2022 −2,0%**, 2023 +1,1%, 2024 +3,4%, 2025 +2,5%, 2026 +2,1%. Positif di 5 dari 6 tahun, tapi rugi saat bear market 2022 dan di paruh pertama 2024.
- **Putusan:** tetap **stoch < 20**. Pilihan IS tetap aturan sekarang. Versi longgar menambah ~30% trade dan lebih bagus di OOS, tapi kedua periode tidak sepakat, dan hybrid berbasis regime BTC tidak memperbaikinya. Menaikkan level karena OOS-nya bagus berarti memilih dari data ujian.
- **Opsi:** catat sinyal < 50 sebagai "shadow" di paper bot (tanpa dieksekusi) untuk diuji ke depan.
- **ZEC:** semua level menghasilkan trade yang sama (30 Sep, $1.403). Level stochastic bukan penyebab ZEC terlewat; itu soal jenis setup (§4.7).
- **1h saat takut:** < 50 lebih jelek dari < 20 (OOS Calmar 0,48 vs 0,88).

### 4.9 Lebih banyak sinyal kapitulasi: tanpa bias 1D, breadth multi-candle (riset lokal)

`npx tsx research/v1-experiments.ts`. Portofolio aturan v1.2. Opsi engine `htfBias` (default aktif, jadi app dan bot tidak berubah).

| Varian | IS CAGR / DD | OOS CAGR / DD | Putusan |
|---|---|---|---|
| **v1.2 (bias 1D, breadth candle yang sama ≥ 10)** | **+13,3% / −14,3%** | +12,4% / −11,2% | tetap pilihan IS |
| Breadth 2 candle (≥ 10…30) | +4,0% s/d +8,6% / −14% s/d −21% | +8% s/d +12,6% | ❌ |
| Breadth 3 candle (≥ 10…30) | +5,8% s/d +11,6% / −14% s/d −22% | +8,5% s/d +14,9% | ❌ lebih jelek di IS |
| Titik hijau tanpa bias 1D (semua varian breadth) | −20% (≥ 10) | −6% s/d −14% | ❌ jauh lebih buruk |

- **Bias 1D adalah filter kualitas yang penting.** Tanpa bias 1D muncul 18.000 sinyal tambahan (IS −0,32%, OOS +0,22% per trade). Walaupun breadth-nya ≥ 10, sinyal itu hanya +0,12% / +0,45%, jauh di bawah sinyal v1 (+1,8% s/d +4%). Kapitulasi yang terbaik terjadi saat tren harian masih utuh (koreksi tajam dalam tren naik), bukan saat tren harian sudah patah.
- **Breadth satu candle lebih tajam dari jendela 2–3 candle.** Kapitulasi yang menyebar adalah kejadian yang lebih lemah.
- **Kesimpulan §4.6–4.9:** v1.2 tetap versi terbaik dari keluarga setup ini. Ruang untuk "lebih banyak peluang" ada di setup lain (Setup A), bukan di pelonggaran v1.

### 4.10 Dua setup satu akun: modal bersama vs modal dibagi (riset lokal)

`npx tsx research/capital-split.ts`. v1.2 (risiko 1%, ≤ 5% per bar) + Setup A (filter volume), 15 posisi per setup. Switching berbasis regime tidak diuji lagi karena sudah gagal di §4.6–4.8.

| Varian | IS CAGR / DD / Calmar | OOS CAGR / DD / Calmar |
|---|---|---|
| v1.2 saja | +13,3% / −14,3% / 0,93 | +12,4% / −11,2% / 1,11 |
| Setup A saja (risiko 0,5%) | +12,3% / −24,8% / 0,50 | +20,3% / −15,0% / 1,35 |
| **1 · Modal bersama, A risiko 0,5%** | **+19,6% / −26,0% / 0,76** | **+30,2% / −19,2% / 1,57** |
| 1 · Modal bersama, A risiko 1% | +23,5% / −44,4% / 0,53 | +37,5% / −26,9% / 1,40 |
| **2 · A risiko 0,5%, A ≤ 30% modal** | +17,3% / **−21,1%** / **0,82** | +26,0% / **−17,0%** / 1,53 |
| 2 · A risiko 1%, A ≤ 30% modal (pilihan IS) | +25,5% / −26,6% / 0,96 | +24,8% / −22,8% / 1,08 |
| 2 · v1.2 juga dibatasi ≤ 50% | selalu lebih jelek | selalu lebih jelek |

- **Gabungan mengalahkan setup tunggal mana pun** di kedua periode: CAGR naik sekitar 1,5× sampai 2,5× dengan drawdown sedikit lebih dalam.
- **Pembagian modal bukan faktor penentu.** Rata-rata modal terpakai hanya 10–34%, jadi batas modal jarang tersentuh. Batas 50–70% sama persis dengan modal bersama. Yang menentukan adalah **ukuran risiko Setup A** (0,5% lebih stabil daripada 1%).
- **Batas A ≤ 30% (risiko 0,5%)** konsisten sedikit memperkecil drawdown (IS −26 → −21%, OOS −19 → −17%) dengan CAGR sedikit lebih rendah. Pilihan IS (A 1% ≤ 30%) justru paling lemah di OOS, jadi tidak dipakai.
- **Membatasi v1.2 selalu merugikan.** Modal untuk kapitulasi tidak boleh dikunci.
- **Rekomendasi:** modal bersama, v1.2 risiko 1% + Setup A risiko 0,5%. Opsional, batas A ≤ 30% modal untuk kurva yang lebih halus. Per tahun (modal bersama): 2021 +14%, 2022 +5%, 2023 +42%, 2024 +39%, 2025 +23%, 2026 +28% (positif setiap tahun; DD terburuk −36,5% di 2024).

### 4.11 Metode pemilik di candle 1D, tanpa breadth dan filter (riset lokal)

`npx tsx research/daily.ts`. Candle daily disusun dari cache 4h (hari UTC). Bias MaxFlow di 1D memakai WaveTrend weekly. Stop −15%, exit di titik merah pertama. Opsi engine `entry: "dot"` untuk entry di titik hijau saja (default tetap titik hijau + stoch).

| Varian | Per trade IS | Per trade OOS | Portofolio IS (CAGR / DD) | Portofolio OOS |
|---|---|---|---|---|
| **1D · MaxFlow + Stochastic** | +0,01% (win 41%, t=0,0) | **−6,92%** (win 29%, t=−6,6) | +0,4% / −31% | **−26,6% / −57%** |
| **1D · MaxFlow saja** | +2,22% (win 51%, t=3,2) | **−3,74%** (win 31%, t=−3,7) | −8,9% / −51% | **−20,6% / −71%** |
| 4h · MaxFlow + Stochastic (pembanding) | +0,64% | +1,57% | −11,0% / −60% | −13,9% / −55% |
| 4h · MaxFlow saja (pembanding) | +0,41% | +1,02% | −22,3% / −75% | −31,6% / −72% |

- **1D gagal, dan rugi besar di periode ujian.** Per tahun (+Stoch): 2021 −8%, 2022 −4%, 2023 +14%, 2024 −10%, **2025 −47%**, 2026 −5%. MaxFlow saja: hanya 2024 yang positif (+35%).
- MaxFlow saja di 1D sempat terlihat bagus di IS (+2,2%/trade), tapi berbalik negatif di OOS. Ini pola klasik yang tidak bisa dipercaya.
- Tanpa breadth, 4h juga rugi di level portofolio (sama dengan temuan §4.6/4.9). Keunggulan setup ini hanya muncul bersama breadth di 4h.
- **Putusan:** jangan pakai MaxFlow (± Stochastic) di 1D sebagai pemicu entry. 1D tetap boleh dipakai sebagai konteks (bias MaxFlow di 4h memang memakai WaveTrend 1D).

### 4.12 Memperkecil loss, memperbesar profit: SL, breakeven, perbaikan entry (riset lokal)

`npx tsx research/stops.ts`. Mesin riset identik dengan engine (v1 5.599/5.599, A 5.362/5.362). Portofolio: v1 risiko 1% ≤ 5%/bar, A 0,5% ≤ 2,5%/bar, ≤ 10% per posisi. Pilihan di IS, dilaporkan di OOS.

**Diagnosis:**
- **v1.2:** 15% trade kena SL, dan stop-out menyumbang **69% dari total kerugian**. Hanya 10% pemenang yang sempat turun lebih dari −8%, dan hanya 5% yang lebih dari −10%. 68% trade yang kena SL sempat naik +2% dulu, 44% sempat +3%.
- **Kasus "titik hijau berikutnya":** entry di titik hijau yang **didahului titik hijau lain dalam 30 candle** (entry kedua dalam satu penurunan) rata-rata **−0,4% IS / +0,9% OOS**, dibanding titik hijau pertama +2,1% / +3,7%. Jadi yang lemah adalah entry di titik hijau berikutnya, bukan yang pertama.
- **Setup A:** stop-out menyumbang hanya 32% kerugian (sebagian besar kerugian dari trailing). **RS vs BTC < −10%** (koin tertinggal, breakout dari base): stop 6% / 4%, **+20,7% / +24,0% per trade** di IS / OOS. Koin yang sudah naik lebih kuat dari BTC (RS ≥ 0) negatif di OOS.

**Eksperimen (Calmar IS │ OOS):**

| Varian | v1.2 | Putusan |
|---|---|---|
| Hari ini (−15%) | 0,93 │ 1,11 | dasar |
| SL −12% / −10% / −8% | 0,80 / 0,63 / 0,56 │ 0,74 / 0,21 / 0,06 | ❌ SL ketat merusak (konsisten dengan §4.4) |
| SL 4×ATR + BE +1R (pilihan IS) | 1,09 │ 0,78 | ❌ gagal OOS |
| Breakeven +3% / +5% / +8% | 0,83 / 1,18 / 0,94 │ 0,87 / 0,74 / 1,04 | ❌ win rate naik ke 74%, tapi rata-rata per trade turun; +5% gagal OOS |
| Konfirmasi candle berikutnya | 0,09 │ 0,30 | ❌ |
| Hanya titik hijau kedua (+higher low) | negatif / sangat jarang | ❌ |
| **Hanya titik hijau pertama** | **0,98 │ 1,17** (OOS +2,66%/trade vs +2,12%) | ✅ perbaikan kecil tapi konsisten (bukan pilihan IS) |

| Varian | Setup A | Putusan |
|---|---|---|
| Hari ini (8×ATR) | 0,50 │ 1,36 | dasar |
| SL 6/5/4×ATR | 0,56 / 0,59 / 0,72 │ 1,37 / 1,12 / 1,09 | ➖ CAGR naik, DD juga naik. Dengan sizing berbasis risiko, SL ketat = posisi lebih besar, jadi efeknya sama dengan menaikkan risiko |
| Pilihan IS (tidak extended, 4×ATR) | 0,81 │ 1,28 | ➖ lebih agresif, risk-adjusted tidak lebih baik |
| Breakeven, konfirmasi candle berikutnya | campur / lebih jelek | ❌ |
| **Filter RS vs BTC < −10%** | **1,16 │ 1,48** (win 47%, +12,8% / +13,7% per trade, 40–45 trade/tahun) | ✅ temuan terkuat. Catatan: arah filter ini sudah terlihat di diagnosis IS §4.7, tapi ambang −10% dipilih setelah melihat kedua periode |

**Gabungan (modal bersama):**

| | IS CAGR / DD / Calmar | OOS CAGR / DD / Calmar |
|---|---|---|
| Hari ini: v1.2 + A | +19,6% / −26,0% / 0,76 | +30,4% / −19,2% / 1,58 |
| **v1.2 + A (RS < −10%), 0,5%** | **+25,5% / −16,9% / 1,51** | **+30,4% / −15,7% / 1,93** |
| v1.2 + A (RS < −10%), 1% | +37,7% / −26,7% / 1,41 | +41,7% / −23,2% / 1,80 |

- Per tahun (RS < −10%, 0,5%): 2021 +13%, 2022 +19%, 2023 +58%, 2024 +58%, 2025 +16%, 2026 +15%. DD terburuk −27% (2024), turun dari −36,5%. Win rate gabungan 56% (dari 42–47%).
- **Konsekuensi:** filter ini melewatkan sebagian pemenang besar. Dari 138 trade A dengan hasil > +50%, 82 lolos filter. **ZEC Agustus 2026 (RS −3,9%) tidak akan diambil.**
- **Status:** ✅ 2026-10-04 di engine bersama sebagai opsi (`firstDotOnly`, `maxRs`; identik dengan riset 5.094/5.094 dan 5.361/5.361), di bot (`V1_FIRST_DOT_ONLY`, `A_MAX_RS`; default mati) dan di scanner (kolom RS saat entry, centang "RS < −10%"). Aktif di paper lokal $300.

### 4.13 Trade yang kena SL: sempat untung? Bisakah TP sebelum berbalik? (riset lokal)

`npx tsx research/reversal.ts`.

**Profil trade yang kena SL:**

| | v1.2 (299 dari 2.043 trade kena SL) | Setup A (178 dari 1.362) |
|---|---|---|
| Sempat hijau ≥ +1% | 87% | 85% |
| Puncak untung sebelum SL (median / rata-rata) | **+2,7% / +3,9%** | **+5,0% / +7,5%** |
| Sempat ≥ +3% / +5% / +10% | 44% / 21% / 7% | 66% / 49% / 25% |
| Waktu ke puncak, lalu ke SL (median) | 0,5 hari, lalu 3,7 hari | 0,8 hari, lalu 4,0 hari |
| Pemenang: puncak median, yang tersimpan saat exit | +13,3%, 55% tersimpan | +66%, 35% tersimpan (mengembalikan +44%) |

**Exit lebih awal (trade yang sama, rata-rata per trade, hari ini → dengan aturan):**
- v1.2 · WT cross turun (level berapa pun): yang kena SL −15,2% → −3,9%, **tapi pemenang +9,9% → +4,8%**, total +2,7% → +1,5%.
- v1.2 · kembali ke entry setelah +5%: total +2,7% → +2,2%. TP penuh di +3/5/8%: total → +0,5/0,7/1,3%.
- Setup A · stoch/WT cross turun: pemenang +43% → +2%, total +7,9% → ~0%. Kembali ke entry setelah +3%: total → +3,1%.
- **Setiap aturan exit lebih awal menurunkan rata-rata per trade.** Sinyal pembalikan yang sama juga muncul di awal perjalanan trade pemenang (49% pemenang v1 sempat turun > −3%), dan jumlah pemenang 4× lebih banyak daripada yang kena SL.

**Portofolio (Calmar IS │ OOS):** v1.2 hari ini 0,93 │ 1,11. Pilihan IS (WT cross turun) 1,99 │ **−0,13** ❌. Yang lain: 0,56–1,36 │ 0,49–1,14, tidak ada yang lebih baik di kedua periode. Setup A hari ini 0,50 │ 1,31. Pilihan IS (kembali ke entry setelah +3%) 0,81 │ **0,37** ❌. TP sebagian 50% di +10/20/30%: 0,50–0,55 │ 0,82–0,94 ❌.

**Putusan:** jangan menambah TP lebih awal atau exit pembalikan. Kerugian dari trade yang kena SL adalah "biaya" untuk tetap memegang pemenang. Cara mengurangi SL yang terbukti adalah **memilih entry** (§4.12: filter RS Setup A, titik hijau pertama di v1), bukan exit yang lebih cepat.

### 4.14 Tahap 7 F1–F4: data posisi futures sebagai confluence (riset lokal)

`npx tsx research/futures.ts` (data, sekali) · `npx tsx research/confluence.ts`. Data: 471 dari 653 koin punya perpetual. Funding sejak 2021; OI, long/short, dan taker sejak 2021-12 (BTC sejak 2020-09). Trade memakai aturan bot saat ini: v1.2 titik hijau pertama, breadth dihitung dari semua sinyal v1; Setup A dengan volume, dengan dan tanpa RS < −10%. Cakupan data futures: v1.2 IS 551/894 · OOS 855/946; A (RS) 235/294 · 155/166.

**F3 · diagnosis** (tercile dipotong di IS, arah ditetapkan sebelumnya):
- **v1.2:** IS mengonfirmasi 5 fitur (funding, funding 3 hari, long/short semua akun, long/short top trader, basis: makin rendah makin baik). Contoh terkuat: long/short semua akun rendah +7,1% vs tinggi −2,9% per trade. **Di OOS hampir semuanya hilang atau berbalik:** funding rendah +2,7% vs tinggi +3,9%; long/short +2,3 / +4,8 / +2,4%; basis tinggi +7,4% (terbaik).
- **Setup A (dengan dan tanpa RS):** **tidak ada fitur yang terkonfirmasi di IS.** Di OOS beberapa fitur malah menunjukkan arah sebaliknya dari hipotesis (funding, basis, dan long/short tinggi lebih bagus, yaitu efek momentum/keramaian di bull market 2024–2026).
- **OI:** tidak konsisten untuk kedua setup.

**F4 · exposure** (Calmar IS │ OOS): v1.2 hari ini 0,98 │ 1,17. Semua skema skor (0,5×/1,5×, skip, 1,5× saja) **lebih jelek di IS** (0,65–0,89), jadi pilihan IS tetap "tanpa confluence". Setup A: tidak ada fitur, tidak ada skema. Gabungan tidak berubah: 1,40 │ 1,76.

**F4 · peringatan exit** (trade yang sama, ditutup saat peringatan pertama, rata-rata per trade IS │ OOS): long/short ≥ 2,5 saat profit di v1.2 +2,06 → +2,87% │ +3,70 → **+2,88%** ❌. Funding ≥ 0,05% di A (RS) +20,7 → **+12,4%** │ +24,0 → +29,1% ❌. Peringatan lain jarang muncul atau netral.

**Putusan:** data posisi futures **tidak memberi confluence yang stabil** untuk v1.2 maupun Setup A. Perilakunya berbalik antara 2022–pertengahan 2024 (bear/pemulihan: keramaian long buruk) dan pertengahan 2024–2026 (bull: keramaian long malah bagus). Tidak diterapkan ke bot. Catatan: periode IS untuk data ini lebih pendek (±2,5 tahun) dan didominasi satu regime, jadi kesimpulan ini juga bisa berubah. Collector di VPS (F6) tetap berguna untuk menguji ulang dengan data yang lebih panjang.

### 4.15 Metode take-profit untuk v1.2 dan Setup A (riset lokal)

`npx tsx research/tp.ts`. Entry sesuai bot saat ini (v1.2 titik hijau pertama; A volume + RS < −10%; A semua RS sebagai pembanding). SL tidak berubah. Pilihan di IS, dilaporkan di OOS.

**Setup A (bot) berdiri sendiri, Calmar IS │ OOS:** hari ini 8×ATR 1,15 │ 1,48.

| Metode | Calmar IS │ OOS | Putusan |
|---|---|---|
| Trailing tetap 5 / 6 / 10 / 12×ATR | 1,09 / 0,97 / 0,77 / 0,62 │ 1,91 / 1,99 / 0,94 / 0,81 | ➖ tidak konsisten; trailing lebih longgar selalu lebih buruk |
| 12×ATR kalau volume entry ≥ 3× / ≥ 5× (usulan pemilik, di atas 8×) | 1,14 / 1,15 │ 1,46 / 1,47 | ➖ netral |
| **6×ATR, 10× kalau volume entry ≥ 3×** | **1,33 │ 2,07** (pembanding semua RS: 0,55 │ 1,79 vs 0,50 │ 1,31; pilihan IS di sana) | ✅ |
| Trailing 12× setelah candle naik bervolume ≥ 5× / 10× | 0,73 / 0,78 │ 0,76 / 0,74 | ❌ |
| Exit di volume klimaks ≥ 5× / ≥ 10× (pilihan IS) | 1,94 / 2,14 │ 1,95 / 1,92 | ⚠️ sendirian bagus, tapi di gabungan OOS turun (1,76 → 1,57). Rata-rata per trade turun dari +21–24% ke +12–13% |
| **Perketat ke 5×ATR setelah +100%** | **1,35 │ 2,11** | ✅ |
| Perketat ke 5×ATR setelah +50% | 1,35 │ 2,19 | ✅ (CAGR IS lebih rendah) |
| Turtle (close di bawah low 10 hari) | 0,64 │ 0,86 | ❌ |

**v1.2** (hari ini 0,98 │ 1,17): trailing low 10 candle / 3×ATR setelah titik merah 0,87 / 0,96 │ 0,34 / 0,50 ❌. Trailing hanya kalau breadth ≥ 25/40 0,92 / 0,98 │ 0,77 / 0,85 ❌. Trailing kalau candle titik merah bervolume ≥ 3× 0,91 │ 1,35 ➖ (IS sedikit lebih buruk). Volume klimaks 0,84–0,98 │ 1,11–1,16 ➖. **TP di titik merah pertama tetap terbaik.**

**Gabungan (v1.2 hari ini + varian A):**

| | IS CAGR / DD / Calmar | OOS CAGR / DD / Calmar |
|---|---|---|
| Hari ini | +25,0% / −17,9% / 1,40 | +31,6% / −17,9% / 1,76 |
| **A: perketat ke 5× setelah +100%** | **+27,2% / −17,4% / 1,57** | **+33,9% / −17,9% / 1,89** |
| **A: 6×, 10× kalau volume entry ≥ 3×** | **+25,3% / −16,2% / 1,56** | **+35,2% / −16,9% / 2,09** |
| A: keduanya digabung | +27,4% / −17,6% / 1,55 | +35,0% / −18,1% / 1,93 |
| A: exit volume klimaks ≥ 10× | +30,6% / −13,6% / 2,25 | +28,5% / −18,2% / 1,57 ❌ |

- "Perketat setelah +100%" sama atau lebih baik dari hari ini **di setiap tahun** 2021–2026 (2024: +60 → +70%).
- Catatan: sekitar 30 varian diuji, jadi perbaikan sebesar +0,1–0,3 Calmar bisa sebagian kebetulan. Dua kandidat di atas dipilih karena konsisten di IS, OOS, dan di semesta A tanpa filter RS.
- **Status:** kandidat. Belum di bot, menunggu keputusan pemilik.

### 4.16 Setup A: trailing dirapatkan setelah lonjakan (usulan pemilik, riset lokal)

`research/tp.ts` (opsi `spike`). Saat posisi sedang profit dan terjadi lonjakan besar, trailing chandelier dirapatkan dari 8×ATR ke k×ATR sampai exit. Tujuannya mengunci profit lonjakan sebelum harga mengembalikannya. Tiga definisi lonjakan ditetapkan sebelum melihat hasil: naik ≥ 20/30% dalam sehari; candle 4h hijau dengan range ≥ 3/4×ATR; candle hijau dengan volume ≥ 5/10× rata-rata. k = 3, 4, 5.

**Gabungan v1.2 + Setup A, Calmar IS │ OOS:** hari ini **1,40 │ 1,76**.
- Semua 18 varian berada di **1,46–1,99 │ 1,83–2,45**: lebih baik di kedua periode, kecuali 3 varian yang setara di OOS. Polanya berupa plato yang lebar, bukan satu angka yang kebetulan.
- **Pilihan IS: candle hijau range ≥ 3×ATR → 4×ATR: +26,9% / −13,5% / 1,99 │ +33,7% / −14,7% / 2,29** (hari ini +25,0% / −17,9% │ +31,6% / −17,9%).
- Naik ≥ 20% sehari → 4×ATR: 1,78 │ **2,45** (OOS +37,1% / −15,2%).
- Volume ≥ 5× → 4×ATR: 1,81 │ 2,25.
- Per trade (pilihan IS): profit yang dikembalikan dari puncak oleh trade menang turun **+43% → +27% (IS) dan +50% → +34% (OOS)**. Rata-rata per trade IS +20,7% → +14,3%, OOS +24,0% → +24,3%; posisi lebih cepat selesai sehingga modal berputar.
- Per tahun (pilihan IS): 2021 +12,0 → +12,3%, 2022 +19,2 → +18,9%, 2023 +56,1 → +55,5%, 2024 +60,0 → **+66,9%** (DD −26 → −22%), 2025 +16,8 → +21,6%, **2026 +13,5 → +7,2%**. Drawdown lebih kecil di setiap tahun.
- Lebih baik dari "perketat setelah +100%" (§4.15: 1,57 │ 1,89).
- **Status:** ✅ 2026-10-04 di engine bersama (`spikeTighten`, identik dengan riset 5.734/5.734), di bot (`A_SPIKE_TIGHTEN`, default mati; aktif di paper lokal), di indikator Setup A (aktif secara default) dan di scanner (kolom "Exit below").

### 4.17 Dengan TP trailing lonjakan: apakah filter entry bisa dilonggarkan? (riset lokal)

Gabungan v1.2 + Setup A dengan trailing lonjakan (§4.16). Filter RS Setup A dilonggarkan bertahap; v1 titik hijau pertama vs semua titik hijau. Calmar IS │ OOS (trade/tahun):

| Setup A | v1 titik hijau pertama | v1 semua titik hijau |
|---|---|---|
| **RS < −10% (bot)** | **1,95 │ 2,25** (128/th, DD −13,5% / −14,7%) | 1,97 │ 2,22 |
| RS < −7,5% | 1,77 │ 2,01 (136/th, DD −15%) | 1,66 │ 1,88 |
| RS < −5% | 1,44 │ 2,03 | 1,43 │ 1,90 |
| RS < −2,5% | 1,32 │ 1,84 | 1,29 │ 1,61 |
| RS < 0% | 1,29 │ 1,53 (DD −18,5% / −19,9%) | 1,25 │ 1,32 |
| Tanpa filter RS | 0,60 │ 1,81 (195/th, DD −24,6% / −16,7%) | 0,63 │ 1,53 |

- **Makin longgar, makin buruk, hampir monoton di kedua periode.** Filter −10% tetap terbaik. Trailing lonjakan tidak menggantikan fungsi filter RS.
- Per tahun (RS −10% → tanpa filter): 2023 +55,5% → +24,9%, 2024 +66,9% → +39,1%, tapi **2026 +5,6% → +29,0%**. Tahun ini koin pemimpin (yang sudah kuat) yang naik, jadi filter RS ketinggalan. Di tahun-tahun lain filter ini menang besar.
- v1 titik hijau pertama vs semua titik hijau: hampir sama dengan TP baru (perbedaan kecil).
- **Putusan:** filter RS < −10% dipertahankan. Kompromi kalau ingin lebih banyak peluang: −7,5% (Calmar sedikit lebih rendah, DD −15%).

### 4.18 Memaksimalkan profit: re-entry, pyramiding, trailing 2×ATR, funding carry (riset lokal)

`npx tsx research/maximize.ts` · `npx tsx research/carry.ts`. Pembanding: aturan bot saat ini (v1.2 titik hijau pertama + A RS < −10% + trailing lonjakan), gabungan **1,99 │ 2,29** (CAGR +26,9% / +33,7%, DD −13,5% / −14,7%). Mesin riset identik dengan `tp.ts` (5.734 breakout).

| Eksperimen | Calmar IS │ OOS | CAGR IS / OOS | DD IS / OOS | Putusan |
|---|---|---|---|---|
| Re-entry di atas close tertinggi trade sebelumnya (≤ 30 hari) | 1,60 │ 2,24 | +24,5 / +34,3% | −15,3 / −15,3% | ❌ |
| Re-entry di breakout baru tanpa filter RS/volume | 1,87 │ 2,29 | +25,4 / +34,6% | −13,5 / −15,1% | ❌ |
| **Pyramiding di +1R, risiko 0,25%** (pilihan IS) | **2,31 │ 2,33** | **+33,1 / +39,0%** | −14,3 / −16,7% | ✅ kandidat (OOS hanya sedikit lebih baik) |
| Pyramiding di +1R, risiko 0,5% | 2,13 │ 1,94 | +38,0 / +42,1% | −17,9 / −21,8% | ➖ terlalu agresif |
| Pyramiding di +2R, risiko 0,25% / 0,5% | 1,91 / 1,62 │ 2,65 / 2,68 | +28,6–30,0 / +40,0–44,5% | −15–19 / −15–17% | ➖ tidak konsisten |
| Trailing 2×ATR setelah volume ≥ 5× (usulan pemilik) | 1,48 │ 2,02 | +20,5 / +26,7% | −13,9 / −13,2% | ❌ terlalu rapat |
| Trailing 2×ATR setelah range ≥ 3×ATR / naik ≥ 20% sehari | 1,72 / 1,90 │ 1,84 / 2,10 | | | ❌ 4×ATR tetap titik terbaik |
| + Funding carry (entry ≥ 0,03% / 0,05%) | 1,94 / 2,03 │ 2,24 / 2,28 | | | ➖ netral |

- **Funding carry berdiri sendiri:** per carry sangat aman (win 94–98%, rata-rata +3–5% modal, terburuk −1 s/d −3,5%), tapi peluangnya hampir hilang setelah 2021: 2021 +12–14%, 2024 +3–5%, 2025–2026 < +1% per tahun. Tidak sepadan dengan kerumitan akun futures saat ini.
- **Pyramiding +1R 0,25% per tahun:** 2021 +12,3 → +12,8%, 2022 +18,9 → +18,0%, 2023 +55,5 → +62,1%, **2024 +66,9 → +121,7%**, 2025 +21,6 → +18,0%, 2026 +7,2 → +2,3%. Profit tambahan terkonsentrasi di tahun tren kuat; di tahun lemah sedikit lebih buruk. Untuk modal $300, posisi tambahan (sekitar 0,25% ÷ jarak ke trailing) sering di bawah minimal order Binance.
- **Status:** belum ada yang dipasang.

**Catatan: trailing dikunci (ratchet) atau tidak?** Chandelier = close tertinggi − k × ATR. Close tertinggi tidak pernah turun, tapi ATR naik saat volatilitas melonjak (sering saat harga jatuh), sehingga garis trailing bisa turun. Diuji versi yang hanya boleh naik (gabungan, Calmar IS │ OOS): tanpa trailing lonjakan 1,40 │ 1,76 → dikunci 1,45 │ 1,80 (sedikit lebih baik); **dengan trailing lonjakan (bot) 1,99 │ 2,29 → dikunci 1,83 │ 2,19 (lebih buruk)**, terutama 2024 (+66,9 → +55,2%). Setelah trailing dirapatkan ke 4×ATR, ruang dari ATR yang melebar justru mencegah exit terlalu cepat di guncangan setelah lonjakan. Tetap tidak dikunci.

### 4.19 MaxFlow + Stochastic saja di candle 1h (riset lokal)

`npx tsx research/h1.ts`. Tanpa breadth, RS, atau filter lain (hanya pair ≥ $1M/hari). Exit di titik merah pertama, stop −15%. Rata-rata per trade **kotor** sama dengan biaya impas; nilai bersih dihitung di 0,04% (futures limit), 0,1%, dan 0,2% (spot market).

| Varian | IS kotor (t) │ bersih 0,04% / 0,2% | OOS kotor (t) │ bersih 0,04% / 0,2% | Lama |
|---|---|---|---|
| Titik hijau + stoch (5 atau 14) | +0,42% (4,5) │ +0,38% / +0,22% | **+0,01% (0,1)** │ −0,03% / −0,19% | 25 jam |
| + stoch 5,3,3 | +0,47% (2,9) │ +0,43% / +0,27% | +0,23% (1,2) │ +0,19% / +0,03% | 26 jam |
| + stoch 14,3,3 | +0,43% (4,5) │ +0,39% / +0,23% | −0,03% │ −0,07% / −0,23% | |
| Titik hijau pertama + stoch | +0,39% (4,2) │ +0,35% / +0,19% | +0,01% │ −0,03% / −0,19% | |
| Titik hijau saja | +0,36% (6,4) │ +0,32% / +0,16% | −0,04% │ −0,08% / −0,24% | |
| Tanpa bias 4h | +0,21% (6,7) │ +0,17% / +0,01% | **−0,32% (−9,1)** │ −0,36% / −0,52% | |

- **Keunggulan di 2021–pertengahan 2024 hilang di OOS** (rata-rata kotor sekitar 0%). Biaya impasnya terlalu kecil bahkan untuk futures maker.
- **Portofolio** (risiko 1%, ≤ 15 posisi, ~1.200 trade/tahun): semua varian rugi di 0,2% dan 0,1%. Di 0,04%: −7,6% / −18,5% per tahun (dasar). Hanya 5,3,3 yang hampir impas (+0,9% / +2,9%, DD −33%). Per tahun (dasar, 0,04%): 2021 +14%, 2022 −5%, 2023 −15%, 2024 −28%, 2025 −36%, 2026 +15%.
- **Bias 4h tetap penting:** tanpa bias, hasilnya jauh lebih buruk (sejalan dengan §4.9 di 4h).
- **Putusan:** tidak ada keunggulan yang bisa ditradingkan di 1h dengan MaxFlow + Stochastic saja. Tidak ditambahkan ke bot atau scanner. Sejalan dengan §4.7 (D): di 1h, keunggulan hanya muncul dengan filter kondisi pasar, dan itu pun tipis.

### 4.20 Posisi 50% modal dan SL maksimal 5% (riset lokal)

Gabungan v1.2 + Setup A dengan aturan bot. Calmar IS │ OOS, CAGR, DD:

| Varian | IS | OOS | Trade/tahun · win | DD terburuk (2021 → sekarang) |
|---|---|---|---|---|
| **Bot sekarang** (risiko 1% / 0,5%, stop asli) | **+26,9% / −13,5% / 1,99** | **+33,6% / −14,7% / 2,29** | 130 · 58% | −21,9% |
| 50% modal per posisi, SL ≤ 5% | +25,7% / −47,0% / 0,55 | +43,7% / −41,0% / 1,07 | 41–45 · 31–37% | **−52,8%** |
| 50% modal, stop asli | +21,6% / −38,8% / 0,56 | +37,6% / −32,9% / 1,14 | 30 · 51–60% | −51,0% |
| Ukuran berbasis risiko, SL ≤ 5% | +27,4% / −26,8% / 1,02 | +20,9% / −23,4% / 0,89 | 125–131 · 35–38% | −35,0% |

- **SL 5% terlalu rapat untuk kedua setup:** v1 yang kena stop naik dari 11–19% ke 51–55%, Setup A dari 3–5% ke 68–74%. Pantulan v1 normalnya turun 8–12% dulu; stop Setup A normalnya sekitar 20% (8×ATR).
- **Posisi 50% = paling banyak 2 posisi:** diversifikasi hilang, dan hasil tahunan jadi seperti lotre (2024 +207% / DD −53%, 2025 −25%).
- **Putusan:** tidak dipakai.

### 4.21 1h MaxFlow + Stochastic dengan SL ≤ 5%, TP 1:2, dan 50% modal per posisi (riset lokal)

Entry seperti §4.19 (titik hijau + stoch cross < 20, bias 4h). SL tetap −5% (TP +10%), atau SL di low 10 candle (1–5%, TP 2R). Kalau SL dan TP tersentuh di candle yang sama, dihitung SL. Posisi 50% modal (≤ 2 bersamaan). Impas dengan biaya 0,2% butuh TP tercapai sekitar 34–35%.

| Varian | IS: TP tercapai · bersih/trade | OOS: TP tercapai · bersih/trade | Portofolio 0,2% IS │ OOS (CAGR / DD) |
|---|---|---|---|
| Stoch 5\|14, SL 5%, TP 10% | 37,6% · +0,44% | **32,2% · −0,37%** | −13% / −67% │ −58% / −92% |
| Stoch 5,3,3, SL 5%, TP 10% | 39,1% · +0,66% | 31,9% · −0,42% | −34% / −86% │ −57% / −89% |
| Stoch 5\|14, SL swing (rata-rata 2%), TP 2R | 35,2% · −0,07% | 34,0% · −0,08% | −70% / −99% │ −67% / −92% |
| Stoch 5,3,3, SL swing, TP 2R | 36,5% · +0,04% | 32,4% · −0,15% | −53% / −95% │ −62% / −90% |

- $98 sejak 2021 → $0–8; 12 bulan terakhir → $33–55. Tahun 2025: −69 s/d −86%.
- **Putusan:** gagal total. Di OOS, TP tercapai di bawah titik impas. Ukuran 50% memperbesar kerugian. Tidak dipakai.

### 4.22 1h: entry di titik hijau, SL di bawah swing low, TP di titik merah (riset lokal)

Titik hijau MaxFlow (bias 4h) tanpa stochastic. SL 0,2% di bawah low 10 (atau 20) candle, maksimal 15%. Exit di titik merah pertama. Pair ≥ $1M/hari.

| | IS | OOS |
|---|---|---|
| Kena SL | 55% | **60%** |
| Win rate · rata-rata menang / kalah | 37% · +4,1% / −2,2% | 33% · +3,9% / −1,9% |
| Jarak SL rata-rata · lama posisi | 2,8% · 11 jam | 2,3% · 10 jam |
| Rata-rata kotor / bersih (0,2%) per trade | +0,08% / −0,13% | +0,01% / **−0,19%** |
| Portofolio risiko 1%, biaya 0,2% (CAGR / DD) | −54% / −95% | −66% / −92% |
| Portofolio 50% modal, biaya 0,2% | −80% / −99,7% | −87% / −99% |

- Swing 10 dan 20 candle hampir identik: titik hijau muncul setelah penurunan, sehingga low-nya sama.
- Rugi di setiap tahun 2021–2026. $98 sejak 2021 → $0–2; 12 bulan terakhir → $6 (50% modal) / $36 (risiko 1%).
- 60% trade menyentuh swing low sebelum titik merah: harga sering menyapu low terakhir sebelum memantul. Stop di balik level yang jelas rawan kena sweep (sama dengan temuan §4.3).
- **Putusan:** gagal. Tidak dipakai.

### 4.23 1h: titik hijau + stoch cross < 30, SL di bawah swing low, TP 1:1 / 1:2 / titik merah (riset lokal)

| TP | IS: kena SL · win · kotor/trade | OOS: kena SL · win · kotor/trade | Bersih 0,2% (IS │ OOS) | Portofolio risiko 1% (IS │ OOS CAGR) |
|---|---|---|---|---|
| 1:1 | 49% · 51% · +0,05% | 50% · 50% · +0,09% | −0,15% │ −0,11% | −40% │ −44% |
| 1:2 | 65% · 35% · +0,12% | 66% · 34% · +0,14% | −0,09% │ −0,06% | −36% │ −43% |
| Titik merah | 57% · 35% · +0,08% | 60% · 33% · +0,08% | −0,12% │ −0,12% | −41% │ −52% |

- Jarak SL rata-rata 2,2–2,6%, lama posisi 7–15 jam, sekitar 1.600–1.700 trade per tahun. Rugi di setiap tahun 2021–2026 untuk semua TP; 50% modal lebih buruk (−49% s/d −86% per tahun).
- Rata-rata kotor per trade (+0,05% s/d +0,14%) lebih kecil dari biaya spot. Hanya TP 1:2 di biaya futures limit order (≈ 0,04%) yang tipis positif (≈ +0,1% per trade); tidak cocok untuk akun spot.
- **Putusan:** gagal. Ini percobaan ke-5 MaxFlow di 1h (§4.19, 4.21–4.23), dengan kesimpulan yang sama.

### 4.24 Intraday 5m/15m: sweep & reclaim dan opening range breakout per sesi (riset lokal)

`npx tsx research/intraday-pairs.ts` (data 5m, 30 pair paling likuid, 2022 → sekarang) · `npx tsx research/intraday.ts`. Long saja (akun spot). Aturan ditetapkan sebelum melihat hasil (lihat kepala skrip). 24 kombinasi: 2 strategi × 5m/15m × filter delta (tanpa / pembeli > 50% / > 55% + volume ≥ 1,5×) × TP 1R/2R.

- **Rata-rata per trade *sebelum biaya*: −0,07% s/d +0,003% di semua 24 kombinasi, IS maupun OOS** (n = 6 ribu s/d 120 ribu trade per kombinasi). Tidak ada keunggulan sama sekali, bahkan sebelum fee.
  - Sweep & reclaim: target tercapai 46–48% (1R) / 25–29% (2R), sama dengan kebetulan acak. Filter delta tidak mengubah apa pun.
  - ORB sesi: −0,03% s/d −0,07% per trade sebelum biaya; target 1R tercapai 40–44%.
- Portofolio dari 6 kombinasi terbaik IS: −43% s/d −92% per tahun di biaya 0,15%; −17% s/d −56% bahkan di biaya futures maker 0,04%. Rugi setiap tahun.
- **Putusan:** gagal. Pergerakan 5m/15m di koin besar sejauh pola-pola ini tidak bisa dibedakan dari acak. Orderflow kline (rasio taker) tidak membantu. Kandidat intraday yang tersisa membutuhkan data yang belum dimiliki (likuidasi, orderbook) atau memakai konteks setup 4h yang sudah terbukti.
- Catatan: daftar 30 pair adalah koin yang bertahan sampai sekarang (survivorship), sehingga hasil sebenarnya kemungkinan sedikit lebih buruk.

### 4.25 Strategi intraday dari Gemini: VWAP harian + EMA20 + breakout 20 candle + lonjakan volume, 15m (riset lokal)

`npx tsx research/vwap-breakout.ts`. Aturan persis seperti `crypto_intraday_backtest.py` (Gemini): close > VWAP harian (reset 00:00 UTC) dan > EMA20; close > high 20 candle sebelumnya; volume > faktor × SMA20 volume; entry di close; SL tetap, TP = rr × risiko, SL dicek sebelum TP; fee 0,1% per sisi. Grid Gemini: SL 0,8–2,0% × volume 1,2–2,0× × rr 1,5–3 (140 kombinasi). Data: 30 pair likuid, 15m sejak 2021.

| Versi | Kombinasi dengan rata-rata bersih positif (IS │ OOS) | Median bersih per trade (IS │ OOS) | Default Gemini (SL 1,2%, 1,5×, 1:2) |
|---|---|---|---|
| 30 pair, SL terisi tepat di level (script) | **0/140 │ 0/140** | −0,26% │ −0,22% | win 32–33% · −0,26% / −0,22% · PF 0,73–0,76 |
| Disaring ($50M volume 24 jam + ATR harian > 3%) | **0/140 │ 0/140** | −0,29% │ −0,24% | −0,29% / −0,25% |
| SL terisi di open saat gap (realistis) | 0/140 │ 0/140 | sama (gap jarang di 15m) | sama |

- Rata-rata **sebelum** fee ≈ −0,06% s/d +0,02% per trade: tidak ada keunggulan. Win rate setara acak untuk rasio TP-nya.
- Kombinasi terbaik IS (SL 1,8%, 2×, 1:2,5): −0,25% / −0,20% per trade. Portofolio risiko 1%: −92% / −64% per tahun. Default Gemini: −99,6% / −94%. "Total return per pair" versi script: −83% s/d −94%.
- **Putusan:** gagal, konsisten dengan §4.24. Intraday 15m berbasis harga + volume di koin likuid tidak punya keunggulan, bahkan sebelum biaya.

### 4.26 Perbaikan dari Gemini: ADX, tren 1h, breakout-retest, SL berbasis ATR (riset lokal)

`npx tsx research/vwap-breakout-v2.ts`. Dasar §4.25 + ADX(14) > 25 (atau > 20) + close > EMA200 1h (atau tanpa) + entry retest dengan candle konfirmasi engulfing/pinbar (atau langsung) + SL 1,5 (atau 2) × ATR14 + TP 1:2 (atau 1:1,5 / 1:3). 48 kombinasi, aturan ditetapkan sebelum melihat hasil.

- **Bersih setelah fee: 0/48 kombinasi positif, IS maupun OOS.**
- Sebelum fee: 13/48 (IS) dan 31/48 (OOS) positif. Filter memang memperbaiki rata-rata kotor dari ≈ −0,05% (§4.25) ke ≈ 0 s/d +0,12% per trade, tapi jauh di bawah fee 0,2%.
- **Versi persis Gemini** (ADX > 25, 1h > EMA200, retest, 1,5 ATR, 1:2): win 33–34%, kotor −0,03% / +0,01%, bersih −0,23% / −0,19%, PF 0,77. Portofolio risiko 1%: −81% / −75% per tahun.
- Terbaik IS (ADX > 25, 1h, langsung, 2 ATR, 1:3): bersih −0,14% / −0,17%; portofolio −73% / −62% per tahun. Terbaik OOS (retest, 2 ATR, 1:3): kotor +0,12%, artinya biaya impas sekitar 0,12%, hanya mungkin dengan biaya futures maker, dan IS-nya hanya +0,01%.
- **Putusan:** gagal. Perbaikan kualitatif yang masuk akal tetap tidak menutup biaya spot. Catatan metodologi: setiap putaran "perbaiki lalu uji ulang" di data yang sama menambah risiko kebetulan, sehingga perbaikan berikutnya butuh alasan kuat yang berbeda, bukan tambahan filter.

### 4.27 Diskusi Claude × Gemini, ronde 1: musiman jam, beli kapitulasi, momentum harian (riset lokal)

`npx tsx research/intraday-edge.ts` · diskusi di `Discussion.md`. Data 1h, 653 pair (≥ $5M/hari), long saja.

- **Musiman jam UTC:** semua jam −0,08 s/d +0,08% per jam, tanda tidak konsisten antara IS dan OOS. ❌
- **Beli kapitulasi** (candle 1h turun ≥ 3–4×ATR dengan volume ≥ 3×; exit 3/12/24 jam atau bracket): t per trade terlihat besar (hingga 20) di IS saat BTC ikut flush, tapi **t per kejadian ≈ 0** (105–187 kejadian), dan OOS 3h/12h negatif. Rata-rata IS hanya ditopang oleh beberapa crash di 2021. Flush khusus satu koin terus turun. ❌
- **Momentum harian** (naik ≥ 0,5–1× range sampai 12:00 UTC, pegang sampai 24:00): IS −0,12 s/d −0,46%, OOS +0,27 s/d +0,45%. Tanda berbalik. ❌
- **Catatan metodologi:** sinyal yang muncul serempak di banyak pair harus dinilai per kejadian (per jam), bukan per trade. Kalau tidak, t-stat terlihat jauh lebih kuat dari kenyataannya.

### 4.28 Diskusi Claude × Gemini, ronde 2: Hipotesis A Gemini "Momentum Runner" (riset lokal)

`npx tsx research/momentum-runner.ts`. Data 1h, 653 pair. Trigger: return 24 jam ≥ +10% dengan volume 24 jam ≥ 3× rata-rata 30 hari (≥ $2M/hari). Entry: chase / pullback ke VWAP 24 jam / pullback ke EMA20. Exit: 12 jam, atau bracket (stop 2×ATR, breakeven di +1R, target 3R, maksimal 12 jam).

- **Semua negatif sebelum biaya**, IS maupun OOS:
  - chase −0,82% / −0,66% per trade (t per kejadian −7,7);
  - pullback VWAP −0,29% / −0,38%;
  - pullback EMA20 −0,16% / −0,10%.
- Bracket 3R tidak lebih baik dari exit waktu: manajemen exit tidak menciptakan edge.
- Top gainer intraday cenderung berbalik turun dalam 12 jam. Momentum hanya menang dengan holding panjang dan trailing (Setup A, 4h). ❌

### 4.29 Diskusi Claude × Gemini, ronde 4: funding negatif pasca settlement, diskon basis perp-spot (riset lokal)

`npx tsx research/funding-basis.ts`. Aturan persis usulan Gemini (`Discussion.md` ronde 3), dengan pembanding tanpa filter.

- **Post-funding squeeze** (funding ≤ −0,03 / −0,05 / −0,08% di settlement 00/08/16 UTC, BTC 4h ≥ −2%, taker buy > 50%; beli di close candle 1h pertama, keluar 7 jam kemudian, stop 2×ATR): bruto −0,09 / −0,30 / −0,59% (IS) dan −0,15 / −0,14 / −0,18% (OOS). Pembanding −0,05 / −0,07%. ❌
- **Diskon basis** (perp ÷ spot − 1 ≤ −0,4 / −0,6 / −0,9% dengan OI turun, 4h; keluar 12/24 jam, saat basis kembali ≥ 0, atau stop 2×ATR): **−0,6% s/d −3,3% bruto**, setiap tahun, IS maupun OOS. Pembanding −0,05 s/d −0,19%. ❌
- **Temuan:** funding sangat negatif dan diskon basis besar adalah sinyal **bearish** yang stabil (short yang yakin, bukan short yang terpaksa). Bisa dipertimbangkan sebagai filter penghindar untuk v1/Setup A (belum diuji, butuh izin).
- **FL-SDA** (likuidasi + depth spot, usulan Gemini) dikunci 2026-10-06 di `Discussion.md` ronde 4. Diuji setelah ≥ 100 kejadian dari data collector.

### 4.30 Diskusi Claude × Gemini, ronde 6: listing baru Binance spot (riset lokal) + penutupan siklus intraday

`npx tsx research/listing.ts`. 355 listing sejak 2021 dengan volume ≥ $10M di 24 jam pertama (termasuk yang sudah delist).

- **Pembanding** (beli di close jam ke-0): 24 jam −3,0% / −4,6%; **72 jam −8,3% / −8,3%** (median −14 / −15%). Listing baru cenderung turun.
- **Varian entry Gemini:** ORB 4 jam, lanjutan di jam ke-2, breakout high hari pertama. Masing-masing hanya **7–17 sinyal** per periode. D1 OOS +15,7% hanya ditopang satu trade (PNUT +251%), median −4%, t ≤ 1. ❌
- **Penutupan siklus:** intraday spot long-only dengan biaya 0,2% dari data kline dan futures publik: tidak ada edge yang bertahan (§4.19–4.30, lebih dari 400 kombinasi). Yang tersisa:
  - FL-SDA, dikunci di `Discussion.md`, diuji setelah ≥ 100 kejadian dari collector;
  - filter veto basis/funding untuk v1/A, usulan, butuh izin.

### 4.31 Pantulan support versi Gemini: sweep & reclaim 1h + filter regime + target resistance (riset lokal)

`npx tsx research/support-reclaim.ts` (`Discussion.md`, chart VIRTUAL 1h). Support/resistance = low/high 48 candle; low menembus support lalu close kembali di atasnya dalam ≤ 2 candle → beli. Stop 0,2% di bawah wick, target resistance (≥ 1R), maksimal 48 jam. Regime: tanpa filter / ADX < 25 / di atas EMA200 1D.

- Bruto IS +0,05 / +0,06 / −0,06% → **OOS −0,24 / −0,22 / −0,37%** (t per kejadian −4 s/d −5). 2024–2026 negatif di semua regime.
- Futures maker 0,04% pun OOS −0,26 s/d −0,41%. Spot −0,42 s/d −0,57%. ❌
- Pantulan support yang tampak sempurna di chart adalah hasil memilih jendela setelah kejadian. Versi sistematisnya tidak punya edge.

### 4.32 Value area ala Fabio Valentini: konfirmasi di VAH/VAL (usulan pemilik, riset lokal)

`npx tsx research/value-area.ts`. Profil dari `lib/profile.ts` (sama dengan indikator Volume Profile di chart: 60 baris, VA 70%), dihitung dari bar sebelum tiap hari UTC. Long saja.

- **VAH breakout → retest → bertahan** (target 2R): bruto intraday 5m −0,03 / −0,01%, swing 1h −0,05 / −0,03%. Dengan volume ≥ 1,5×: −0,02 / 0,00% dan −0,03 / +0,01%. ❌
- **VAL breakdown gagal → reclaim → retest → POC:** intraday 0,00 / −0,04%, swing **−0,24 / −0,31%**. ❌
- **VAL + titik hijau MaxFlow:** intraday −0,02 / −0,12%. Swing +0,04% (IS) / **+0,41% (OOS)**, tapi hanya 192 / 102 trade, t 0,1 / 0,7, dan berganti tanda dari tahun ke tahun (−1,0% s/d +1,9%). Tidak signifikan. ➖ Catat saja, tidak dipakai.
- Hasil bruto di level VAH/VAL ≈ 0 (±0,03%) di puluhan ribu trade. Level value area dari kline tidak membawa informasi arah. Keunggulan trader diskresioner di level ini (kalau ada) berasal dari membaca order flow secara langsung, bukan dari levelnya.

### 4.33 Auction market dua arah (long + short) dan refinement ala Fabio (riset lokal)

`npx tsx research/auction.ts`. 5m, 30 pair, profil hari UTC sebelumnya (`lib/profile.ts`). Empat skenario di VAH/VAL: breakout → retest → bertahan (continuation, target 2R) atau gagal (reversion ke POC). Refinement: konteks hari (imbalance/balance), agresi (rasio taker + volume ≥ 1,5×), sesi NY, dan ketiganya sekaligus. Ditambah "80% rule" Dalton. Biaya futures: maker 0,04%, taker 0,1%.

- **Perilaku:** 92–93% breakout di-retest dalam 2 jam. Dari retest itu, 57–58% bertahan dan 42–43% gagal, simetris di VAH dan VAL.
- **Hasil per trade (bruto):** semua skenario dasar −0,02% s/d +0,01%, baik long maupun short. Refinement satu per satu: −0,05% s/d +0,02%.
- **Ketiga refinement sekaligus:** −0,06% s/d +0,08%, hanya 180–335 trade, t ≤ 1,5, tanda berganti per tahun. ❌
- **80% rule:** hanya **45%** yang mencapai sisi seberang VA (bukan 80%). Sebagai pembanding, hari yang dibuka di dalam VA menyentuh kedua sisi 39%. Trade-nya −0,18% s/d +0,06%. ❌
- **Tafsiran:**
  - Kripto berjalan 24/7, sehingga tidak ada lelang pembukaan (*opening auction*). Batas hari UTC bersifat arbitrer, berbeda dengan sesi RTH futures indeks tempat teori ini lahir.
  - Biaya NQ di CME sekitar < 0,01% per round trip, 10–30× lebih murah dari futures kripto, sehingga edge +0,03–0,08% di sana bisa bernilai.
  - Konfirmasi Fabio memakai footprint/tape real-time, bukan rasio taker per 5 menit.

### 4.34 Footprint sungguhan dari aggTrades: initiative dan absorption di VAH/VAL, 5m dan 1m (riset lokal)

`npx tsx research/aggtrades.ts` (data) · `npx tsx research/footprint.ts`. Aggregated trades Binance (setiap transaksi beserta sisi aggressor) untuk BTC, ETH, SOL, XRP, DOGE. IS 2024-01 → 06, OOS 2026-03 → 08. Diringkas ke bar 1 menit: delta, transaksi besar (≥ p99 hari sebelumnya), jual agresif di dasar / beli agresif di puncak bar. Data mentah disimpan di `research/.cache/aggtrades-raw` (13 GB). Basis sama dengan §4.33.

- **Order flow saja:** pergerakan 30 menit setelah retest, menurut delta candle retest: −0,02% s/d +0,04%, tanda berganti antara IS dan OOS. Delta tidak memprediksi arah. ❌
- **Continuation + initiative** (delta ≥ 10% searah, transaksi besar searah): 5m −0,04% s/d +0,01%, 1m −0,05% s/d +0,03%. Tidak lebih baik dari basis. ❌
- **Reversion + absorption:**
  - 1m VAL → long: +0,12% (IS) lalu **−0,05% (OOS)**. ❌
  - 1m VAH → short: +0,06 / +0,04%, hanya 96 / 137 trade, t ≤ 1,5. ➖
  - Di 5m sinyalnya hampir tidak muncul (7–24 trade). Definisi dasar/puncak dihitung per menit, bukan per bar 5m; bisa diperbaiki dari data mentah.
- **Satu-satunya tanda yang konsisten:** 1m "VAH gagal → short ke POC" (dasar) +0,03% / +0,02% bruto (t 2,2 / 1,5). Ini di bawah biaya futures maker 0,04%. Mungkin berarti di pasar berbiaya sangat rendah (NQ), tapi tidak di kripto. ➖
- **Kesimpulan:** footprint dari aggTrades tidak menambah edge yang bisa ditradingkan di VAH/VAL, di 5m maupun 1m.

### 4.35 Value area dari timeframe besar, entry di timeframe kecil: 1h → 15m dan 4h → 1h (riset lokal)

`npx tsx research/auction-htf.ts`. Profil 7 hari dari bar 1h → entry 15m (30 pair), dan profil 30 hari dari bar 4h → entry 1h (639 pair, ≥ $5M/hari). Empat skenario dua arah. Varian: konteks / agresi (taker kline + volume) / keduanya.

- **Perilaku:** sama seperti di 5m. 91–92% breakout di-retest; 58–60% bertahan, 40–42% gagal.
- **1h → 15m:** semua dasar −0,05% s/d +0,04%, tanda berganti IS/OOS. ❌
- **4h → 1h, sisi long:**
  - VAH continuation −0,03 / −0,02%.
  - **VAL gagal → long −0,09 / −0,36%** (t −2,3 / −2,9): membeli breakdown yang "gagal" di bawah VAL 30 hari konsisten rugi. ❌ Bisa jadi bahan veto untuk v1 (belum diuji).
- **4h → 1h, sisi short:**
  - **VAL continuation short:** dasar +0,03 / **+0,14%** (t OOS 2,9); dengan agresi +0,24 / +0,36% (t 1,2 / 2,1). Positif di 2022, 2024, 2025; negatif di 2021, 2023, 2026.
  - Kemungkinan besar ini cerminan drift turun altcoin (semesta termasuk koin yang delist), bukan keunggulan level VA.
  - Belum memperhitungkan funding, ketersediaan perp, dan uji per pair. IS t < 2. ➖ Kandidat cek lanjutan, hanya untuk akun futures.
- Dari 32 baris, beberapa angka besar (misalnya VAH continuation + konteks + agresi OOS +0,84%, hanya 91 trade) wajar muncul karena kebetulan dari banyaknya baris yang diuji.

### 4.36 Refinement pemilik: TP 1:2, SL di bawah node volume besar, entry setelah 3 delta searah (riset lokal)

`npx tsx research/auction-refine.ts` · `npx tsx research/auction-short.ts`. Empat timeframe (4h→1h, 1h→15m, 5m dan 1m dari aggTrades), empat skenario dua arah. Varian ditumpuk:
- **A:** TP 2R;
- **B:** + SL di balik node volume terbesar (profil 48 bar). Orderbook historis tidak tersedia, jadi node volume dipakai sebagai proksi "big order";
- **C:** + entry setelah 3 candle berturut-turut dengan delta searah.

Hasil:
- **1h→15m, 5m, 1m:** semua varian −0,08% s/d +0,08% bruto, tidak konsisten antara IS dan OOS. ❌
- **4h→1h, long:** VAH continuation B +0,05 / +0,06% bruto, tapi **per R −0,06 / −0,04R** setelah biaya dan funding. VAL gagal → long tetap negatif. ❌
- **4h→1h, short VAL continuation:** bruto per trade naik tajam di B (+0,17 / +0,38%) dan C (+0,31 / +0,33%). Tapi kenaikan ini **sebagian besar karena SL yang lebih lebar** (median risiko 1,3% → 3,1–3,5%). Per R setelah taker dan funding, hanya di perp yang tersedia:
  - A −0,04 / −0,02R;
  - B +0,047 / +0,044R (t 3,3 / 2,9);
  - C +0,094 / +0,031R (t 4,1 / 1,3).
- **Portofolio** (risiko 1%, ≤ 10 posisi):
  - B: CAGR −21% / −47%, DD −88%. Saat crash pasar, slot penuh sehingga trade terbaik terlewat.
  - C: +34% / +19%, tapi **DD −57%**. 2021 dan 2026 negatif.
  - ➖ Ada edge kecil di short altcoin yang breakdown, tapi drawdown tidak layak dan butuh akun futures.
- **Pelajaran metodologi:** membandingkan "% per trade" antar varian dengan SL berbeda menyesatkan. Ukuran yang benar adalah hasil per R (ukuran posisi berbasis risiko) dan simulasi portofolio.

### 4.37 Metode pemilik di candle mingguan: titik hijau MaxFlow + stochastic (riset lokal)

`npx tsx research/weekly.ts`. Candle 1W sejak 2017 dari API (pair yang masih listing) dan dari cache 4h untuk pair yang delist. 524 pair, ≥ $1M/hari, biaya 0,2%. Logika v1 disalin dengan warmup 52 minggu. Trade yang masih terbuka dinilai pada harga terakhir.

- **Bias bulanan memblokir hampir semua sinyal** (37 trade di 524 pair). Titik hijau weekly muncul di dasar siklus, saat tren bulanan pasti turun. Contoh BTC: Des 2018, Jun 2022, Des 2025, Feb 2026. Karena itu diuji tanpa bias.
- **Hasil per trade** (IS │ OOS):
  - dot + stoch, SL −15%: +6,8% │ **−6,4%**;
  - SL −30%: +7,4% │ −2,9%;
  - dot saja, SL −30%: +6,9% │ −8,8%.
  - Win rate 12–43%; 53–88% kena stop.
- **Portofolio** (risiko 1%, ≤ 15 posisi): IS +4% / −2% per tahun (DD −23 s/d −40%), OOS −1 s/d −12% (DD −40 s/d −61%). ❌
- **Per tahun:** hanya 2023 (+36 s/d +49% per trade) dan 2024 untuk SL −30%. 2022 dan 2025 rugi besar. Sinyal menumpuk di minggu-minggu crash pasar (Agt 2024: 54 koin, Jun 2022: 44), sehingga ini praktis "beli dip besar lalu tahan berbulan-bulan" yang sangat bergantung pada rezim pasar.
- 2017–2020 positif, tapi hanya 7–12 trade dari koin yang bertahan sampai sekarang (survivorship). Tidak bisa dipakai sebagai bukti.
- **Catatan:** titik hijau weekly BTC menandai dasar siklus. Mungkin berguna sebagai konteks pasar, belum diuji sebagai filter.

### 4.38 Audit bias v1.2 + Setup A: look-ahead, biaya, jam candle, timeframe, parameter (riset lokal)

`npx tsx research/audit.ts` · `npx tsx research/audit-tf.ts`. Memakai engine bot (`lib/setups`) atau salinan yang terbukti identik di 4h. Semua candle dibangun dari cache 1h; 4h+0 mereproduksi baseline (+27,3 / +33,8%).

- **Look-ahead:** ✅ tidak ada. Bias 1D MaxFlow dibangun dari candle yang sudah tutup. Titik dan cross dipakai di candle tempat keduanya diketahui.
- **Survivorship:** ✅ semesta termasuk pair yang delist.
- **Biaya:** riset memakai 0,1% pulang-pergi (bot membayar ±0,2%). Pada 0,2%: +26,5 / +32,8% (DD −13,6 / −15,0%). Pada 0,3%: +25,7 / +31,9%. Dampaknya kecil karena trade rata-rata besar. ✅
- **Jam candle 4h digeser +1/+2/+3 jam** (biaya 0,1%), gabungan / v1.2 / A:

| Mulai candle | Gabungan IS │ OOS | v1.2 IS │ OOS | Setup A IS │ OOS |
|---|---|---|---|---|
| 00 UTC (Binance) | +27,3 │ +33,8% | +13,7 │ +15,7% | +13,7 │ +19,2% |
| +1 jam | +25,3 │ +29,2% | +10,0 │ +9,2% | +14,5 │ +19,8% |
| +2 jam | +24,0 │ +30,4% | +7,8 │ +10,2% | +15,8 │ +20,8% |
| +3 jam | +10,8 │ +32,1% | **−3,2** │ +13,1% | +16,6 │ +19,9% |

- **Timeframe lain, diuji adil** (biaya 0,2%): v1.2 dengan bias 6× chart (di 4h = 1D); Setup A dengan jendela dalam hari dan pengali ATR × √(4h ÷ TF). Engine apa adanya di 2h/3h/12h memberi 0 trade v1, karena bias ≤ 2× chart tidak pernah mengizinkan titik hijau.

| TF | v1.2 IS │ OOS | Setup A IS │ OOS |
|---|---|---|---|
| 1h | +9,5 │ **−15,2%** | +9,4 │ +13,5% |
| 2h | +7,7 │ −2,8% | +12,0 │ +17,5% |
| 3h | −2,5 │ +2,8% | +14,5 │ +23,5% |
| **4h** | **+13,1 │ +15,0%** | +13,5 │ +19,0% |
| 6h | −1,5 │ +22,6% | +15,2 │ +24,4% |
| 8h | −9,8 │ +18,2% | +17,0 │ +13,5% |
| 12h | −3,9 │ −3,6% | +16,5 │ +20,5% |

- **Parameter** (4h, 0,2%):
  - breadth 7 / 10 / 13: +24 / +27 / +15% IS, Calmar 1,26 / 1,95 / 0,88;
  - RS −5 / −10 / −15%: Calmar 1,42 / 1,95 / 1,87;
  - volume 1,2 / 1,5 / 2×: Calmar 2,63 / 1,95 / 1,59.
- **Putusan:**
  - **Setup A kokoh.** Positif di IS dan OOS di semua timeframe 1h–12h dan semua pergeseran jam, CAGR +9 s/d +24%, DD ≤ 15%. Edge trend following yang nyata.
  - **v1.2 rapuh.** Hanya 4h dengan candle Binance (00 UTC) yang positif di IS dan OOS. Pergeseran jam memotong hasilnya separuh (+3 jam: IS −3%), dan timeframe tetangga bergantian rugi di IS atau OOS. Breadth 10 juga tampak seperti puncak sempit.
  - Hasil 4h v1.2 kemungkinan **terlalu optimis**. Ekspektasi realistis jauh di bawah +13–15% per tahun, mungkin mendekati nol.
  - **OOS tidak lagi murni.** Beberapa keputusan (first dot, RS −10%, trailing lonjakan) diambil sambil melihat OOS. Ujian bersih adalah hasil live sejak bot dijalankan.

### 4.39 Risk/reward v1.2 dan Setup A (riset lokal)

`npx tsx research/payoff.ts`. Trade yang lolos filter bot, 4h, biaya 0,2%, R = jarak ke stop awal.

| | Win | Rata-rata menang | Rata-rata kalah | Payoff | Expectancy | 10% trade terbaik | Rugi beruntun terpanjang |
|---|---|---|---|---|---|---|---|
| v1.2 IS │ OOS | 60% │ 60% | +9,6% │ +10,8% | −9,4% │ −6,8% | **1,02 │ 1,58** | **0,14R │ 0,25R** | 142% │ 81% dari profit | 27 │ 27 |
| A IS │ OOS | 60% │ 58% | +30,3% │ +48,5% | −9,3% │ −9,5% | **3,26 │ 5,08** | **0,81R │ 1,34R** | 61% │ 72% | 13 │ 8 |

- **v1.2:** payoff sekitar 1:1 dan sangat bergantung pada win rate 60%. Expectancy hanya 0,14–0,25R. Di IS, 10% trade terbaik menyumbang 142% profit (sisanya rugi bersih). Sejalan dengan kerapuhan di §4.38.
- **Setup A:** payoff 3–5× dengan win rate tetap sekitar 60% (berkat filter volume dan RS). Expectancy 0,8–1,3R per trade.

### 4.40 Support dengan entry di titik SL klasik (usulan pemilik, riset lokal)

`npx tsx research/stop-entry.ts`. Long, limit order, 1h / 4h / 1D, semua pair ≥ $2M/hari. Support = low N bar (48 / 60 / 30), harus segar (tidak tersentuh dalam N/2 bar).
- **A klasik:** beli di support, SL support − 0,5×ATR, TP resistance.
- **B1:** beli di SL-nya A (support − 0,5×ATR), SL entry − 1×ATR, TP resistance.
- **B2:** seperti B1, TP 2R.

| | A klasik (IS │ OOS, per R bruto) | B1 → resistance | B2 → 2R |
|---|---|---|---|
| 1h | −0,16 │ −0,20R (win 8–9%) | −0,03 │ −0,09R | −0,06 │ **−0,04R** |
| 4h | −0,13 │ −0,30R (win 6–8%) | +0,003 │ −0,31R | −0,08 │ −0,15R |
| 1D | −0,25 │ −0,34R (win 10–12%) | −0,12 │ −0,18R | −0,09 │ −0,15R |

- **A klasik sangat buruk:** 88–94% trade kena SL. Membeli di support dengan SL tepat di titik invalidasi memang ladang stop hunt.
- **Entry di titik SL (B) memperbaiki hasil secara besar** (rugi per R berkurang 50–80%, win rate naik dua kali lipat). Fenomena sapuan stop di bawah support memang nyata.
- **Tapi tetap negatif, bahkan sebelum biaya**, di semua timeframe untuk OOS. Setelah menembus support, cukup sering harga benar-benar lanjut turun, sehingga pantulan dari zona sapuan tidak cukup menutup kerugian. Biaya spot 0,2% membuatnya −0,18 s/d −0,24R. ❌

### 4.41 Anatomi sapuan support: seberapa sering memantul, seberapa dalam (riset lokal)

`npx tsx research/sweep-stats.ts`. Kejadian sama dengan §4.40 (support segar ditembus), 2021 → sekarang, semua pair ≥ $2M/hari. "Memantul" = ada close kembali di atas support dalam N bar.

| | 1h (106 rb) | 4h (22 rb) | 1D (7,4 rb) |
|---|---|---|---|
| Memantul | 90% (median di bar yang sama) | 89% | 89% |
| Kedalaman sebelum memantul: median / 75% / 90% | 0,56 / 1,33 / 2,75 ATR (0,9 / 2,1 / 4,5%) | 0,52 / 1,31 / 2,76 ATR (1,7 / 4,6 / 9,7%) | 0,36 / 0,88 / 1,70 ATR (3,8 / 9,7 / 19%) |
| Tidak memantul: turun lagi (median) | 8,1 ATR (−11,8%) | 8,0 ATR (−26%) | 3,4 ATR (−37%) |
| SL klasik (−0,5 ATR) tersentuh | 58% | 56% | 47% |
| …lalu tetap memantul (stop hunt) | 83% | 81% | 76% |
| Peluang memantul jika sudah ≥ 1 / 2 / 3 ATR di bawah | 75 / 59 / 45% | 73 / 57 / 43% | 63 / 39 / 22% |
| Sampai resistance (dari semua tembusan) | 23% | 20% | 14% |

- **Stop hunt nyata:** sekitar separuh tembusan menyentuh SL klasik, dan 76–83% dari itu kembali naik.
- **Tapi "memantul" ≠ untung.** Kebanyakan hanya wick (close di atas support pada bar yang sama). Hanya 14–23% yang sampai ke resistance.
- **Yang tidak memantul jatuh sangat dalam** (8 ATR, −12% s/d −37%).
- **Sapuan berekor tebal:** 10% sapuan yang akhirnya memantul tetap turun 1,7–2,8 ATR dulu. Peluang memantul turun cepat seiring kedalaman.
- Inilah sebabnya entry di −0,5 ATR dengan SL di −1,5 ATR (§4.40) kena SL sekitar separuh waktu: P(≥ 1,5 ATR | ≥ 0,5 ATR) = 47–54%.

### 4.42 USDT dominance dan setup bot (usulan pemilik, riset lokal)

`npx tsx research/usdt-dominance.ts`. Riwayat total market cap tidak gratis, jadi dipakai proksi **USDT ÷ (market cap BTC + ETH)**. Suplai USDT dari DefiLlama; market cap BTC/ETH = close harian × suplai beredar. Sinyal memakai hari sebelum entry.

- **Hari yang sama:** korelasi perubahan harian proksi vs return rata-rata semesta **−0,85 (IS) / −0,81 (OOS)**. Kuat, tapi sebagian besar mekanis: suplai USDT berubah lambat, sehingga USDT.D adalah kebalikan dari market cap.
- **Daya prediksi 7 hari:**
  - IS: proksi di bawah MA50 → semesta +1,5% (vs −1,0% di atas MA50); kuintil perubahan 7 hari berbentuk U, tidak monoton.
  - **OOS: tidak ada perbedaan** (−1,5% vs −1,2%). ❌ Bukan prediktor yang stabil.
- **Filter regime di bot** (biaya 0,2%, IS │ OOS):
  - tanpa filter: +26,1 │ +32,8%, Calmar 1,92 │ 2,20;
  - **hanya risk-on (proksi < MA50):** +25,9 │ **+37,5%**, DD −13,3 │ −12,8%, Calmar 1,94 │ **2,93**;
  - proksi turun 7 hari: +13,4 │ +26,2%;
  - v1.2 saat takut + A saat risk-on: +14,4 │ +17,1%;
  - suplai USDT naik 30 hari: +15,5 │ +32,6%.
- **Per setup:**
  - Setup A hampir tidak pernah memberi sinyal saat proksi di atas MA50 (2–4 per tahun). Breakout 20 hari pada dasarnya sudah risk-on, jadi filter ini nyaris tidak berpengaruh (+13,8 │ +20,2% vs +13,5 │ +19,0%).
  - v1.2 risk-on: +12,3 │ +18,2% (vs +12,9 │ +15,0%). v1.2 hanya saat takut: ≈ 0.
- **Putusan:** ➖ Filter risk-on tidak memperbaiki IS, dan perbaikan OOS bisa saja kebetulan. Informasi USDT.D sebagian besar sudah terkandung dalam setup (bias 1D v1, breakout A). Kandidat untuk dipantau, tidak dipasang. Catatan: memakai proksi, bukan USDT.D asli.

### 4.43 MaxFlow di USDT dominance sebagai peringatan pasar (usulan pemilik, riset lokal)

`npx tsx research/usdt-maxflow.ts`. Candle proksi USDT.D (USDT ÷ market cap BTC + ETH) 4h dan 1D. MaxFlow seperti di chart (filter OB/OS), dengan bias biasa (4h → 1D, 1D → 1W) dan tanpa bias.

- **Event study.** Return rata-rata setelah titik, vs rata-rata harian (IS │ OOS):
  - **Titik hijau di USDT.D (4h, bias 1D), 28 │ 23 kejadian:**
    - BTC 1 hari −1,1% │ −0,2%; 3 hari −0,4% │ +0,5%; **7–14 hari +1,0 / +3,5% │ +0,3 / +0,5%**;
    - semesta altcoin 1 hari −1,3% │ −0,9%.
    - Ada sedikit tekanan **1–3 hari**, tapi bukan puncak tren; setelah seminggu pasar cenderung lanjut.
  - **Titik merah (4h, bias 1D):** semesta +1,3% (1 hari, IS) tapi −1,5% (OOS). Tidak konsisten.
  - **1D:** hanya 2–7 kejadian per periode. Hasilnya berganti tanda dan tidak bisa disimpulkan.
- **Gerbang untuk bot** (biaya 0,2%, IS │ OOS, CAGR):
  - tanpa gerbang +26,1 │ +32,8%;
  - **semua varian lebih buruk**: "tidak entry selama titik terakhir hijau" +3 s/d +13% │ +1 s/d +20%; "tidak entry 7 hari setelah titik hijau" +6 s/d +23% │ +21 s/d +30%. ❌
  - Entry terbaik v1.2 justru sering terjadi saat USDT.D naik (pasar sedang pullback).
- **Putusan:** sebagai alat diskresioner, titik hijau di USDT.D mungkin menandai pullback pendek (1–3 hari), tapi sampelnya kecil dan lemah di OOS. Sebagai filter bot, merugikan. Tidak dipasang.

### 4.44 Mencari koin yang naik 5–15% esok hari (permintaan pemilik, riset lokal)

`npx tsx research/daily-movers.ts`. Candle harian, semesta ≥ $2M/hari, 2021 → sekarang. Hasil hari berikutnya (close → close), IS │ OOS:

| Skrining | Rata-rata esok hari | P(≥ +10%) | P(≤ −10%) | Bersih 0,2% | Buku harian (CAGR) |
|---|---|---|---|---|---|
| Semua koin (tingkat dasar) | +0,09 │ −0,16% | 5,2 │ 4,1% | 4,5 │ 3,8% | −0,11 │ −0,36% | – |
| Breakout 20 hari + volume ≥ 3× | −0,03 │ −0,40% | 12,7 │ 11,1% | 14,2 │ 12,6% | −0,23 │ −0,60% | −97 │ −100% |
| Top 5 gainer (≥ +15%) | −0,89 │ −0,59% | 14,4 │ 14,3% | 22,4 │ 21,8% | −1,09 │ −0,79% | −100 │ −99% |
| **Kapitulasi massal** (−20% dalam 3 hari, ≥ 30% pasar −15%) | **+2,09 │ +2,40%** | 20,5 │ 14,5% | 12,4 │ 4,6% | **+1,89 │ +2,20%** | **+22 │ +9%** (72 │ 44 hari) |
| Squeeze lalu breakout | −0,10 │ +0,68% | 2,8 │ 6,5% | 4,3 │ 2,7% | −0,30 │ +0,48% | −65 │ −28% |
| Pemimpin RS (+30% vs BTC, dekat high) | +0,57 │ −0,52% | 13,9 │ 8,7% | 11,6 │ 10,7% | +0,37 │ −0,72% | −90 │ −98% |

- **Untung 5–15% per hari tidak realistis:** 5% per hari dibungakan = ×5,4 juta per tahun.
- Skrining yang menaikkan peluang naik ≥ 10% (breakout, top gainer, RS) **juga menaikkan peluang turun ≥ 10% sama besarnya**. Volatilitasnya naik, bukan arahnya. Rata-ratanya negatif. ❌
- **Satu-satunya yang positif adalah kapitulasi massal**: esok hari +2,1 / +2,4%, median +2,4%, konsisten dengan ide v1.2 (breadth). Tapi hanya ±20 hari per tahun, sehingga buku hariannya +22 / +9% per tahun, bukan per hari.

### 4.45 "Setup C": kapitulasi massal harian sebagai pengganti v1.2 (riset lokal)

`npx tsx research/setup-c.ts`. Hari flush = ≥ B% semesta likuid turun ≥ 15% dalam 3 hari; beli koin yang turun ≥ D% di close itu. Stop −20%, risiko 1%, ≤ 15 posisi, ≤ 5% risiko baru per hari. Grid D 15/20/25% × B 20/30/40% × exit 1/3/5/10 hari, trailing 2/3×ATR. Biaya 0,2%.

- **Hanya pegang 1 hari yang positif.** Pegang 3–10 hari atau trailing: rugi (OOS −8 s/d −27% per tahun). Pantulan kapitulasi hanya bertahan sekitar satu hari.
- **Pilihan IS** (turun 25%, breadth 30%, 1 hari): +12,2% / DD −8,5% (IS), tapi **−0,6% (OOS)**. Semua varian 1 hari di OOS hanya −0,6 s/d +2,9% per tahun.
- **Batas hari digeser 4–20 jam:** IS +3 s/d +14%, OOS −1 s/d +11%. Sangat bergantung pada jam, sama seperti v1.2.
- **Portofolio** (IS │ OOS):
  - A + v1.2 (sekarang): +26,1 │ +32,8%, Calmar 1,92 │ 2,20;
  - A + C: +27,3 │ +18,2%, Calmar 3,05 │ **0,97**;
  - A + v1.2 + C: +41,4 │ +34,5%, Calmar 2,99 │ 2,16.
- **Putusan:** ❌ Setup C tidak lebih kokoh dari v1.2 dan gagal di OOS. Edge per trade dari §4.44 (+2,4% esok hari) tidak bertahan di portofolio yang realistis: entry dibatasi per hari, koin paling likuid dulu, dan kejadiannya menumpuk di sedikit hari. Bot tetap A + v1.2.

### 4.46 Apakah harness riset bias ke dua setup kita? Uji kontrol (riset lokal)

`npx tsx research/controls.ts`. Semua melalui simulator portofolio yang sama (`momentum.ts simulate`) dan biaya 0,2%.

| Kontrol | IS │ OOS (CAGR, DD) | Arti |
|---|---|---|
| Setup A / v1.2 / A + v1.2 (referensi) | +13,5 │ +19,0% · +12,9 │ +15,0% · +26,1 │ +32,8% | |
| **Positif:** aturan "curang" yang melihat besok (beli jika close besok ≥ +2%) | angka astronomis, win 100% | ✅ harness bisa melihat edge |
| **Negatif:** entry acak + exit Setup A (5 seed) | −1,7 s/d +4,0% │ −2,2 s/d +7,7% | ✅ edge A berasal dari sinyal entry, bukan dari exit atau pasar |
| **Negatif:** entry acak + exit v1.2 (5 seed) | −9,7 s/d +2,7% │ −14,9 s/d +1,9% | ✅ sama untuk v1.2 |
| **Publik:** BTC di atas SMA50, else kas | +20,5 │ +23,1%, DD −57 │ −25% | ✅ edge trend publik terlihat (DD lebih kecil dari beli-tahan) |
| **Publik:** BTC beli-tahan | +23,9 │ +13,7%, DD −76 │ −52% | pembanding |
| **Publik:** momentum mingguan (10 koin terbaik 30 hari) | −33 │ −89% | sejalan dengan §4.28 dan §4.44: mengejar pemenang di semesta bebas survivorship rugi |

- **Putusan:** tidak ada bias kode yang memihak dua setup kita.
  - Harness menemukan edge kalau edge itu ada (kontrol positif, trend BTC).
  - Harness tidak memberi hasil bagus pada entry acak dengan exit yang sama.
  - Sebagian besar strategi yang gagal dinilai dari rata-rata per trade sebelum biaya, tanpa melewati simulator sama sekali.

### 4.47 Anatomi pemenang: ciri tren besar dan reversal, filter veto, timing entry Setup A (riset lokal)

`npx tsx research/anatomy.ts` · `npx tsx research/a-entry.ts`. 4h, semesta bebas survivorship. Fitur dihitung saat keputusan. Kelompok = tercile IS; sebuah fitur dihitung hanya kalau urutannya sama di IS dan OOS.

**1 · Tren: semua breakout Setup A tanpa filter** (IS 0,35R │ OOS 0,03R per trade). Fitur yang konsisten:
- **RS 30 hari vs BTC rendah** (< −10,7%): 0,78R │ 0,67R vs tinggi −0,00 │ −0,25R. Filter bot sudah benar.
- **USDT.D di atas MA50 (takut):** −0,16 │ −0,32R vs risk-on 0,48 │ 0,15R.
- **Range 20 hari sempit** (< 16%, basis yang rapat): 0,54 │ 0,32R vs lebar 0,28 │ −0,12R.
- **Funding ≥ 0,01%:** 0,45 │ 0,36R vs di bawahnya 0,31 │ −0,09R.
- **Basis positif** (≥ +0,04%): 0,53 │ **0,89R** vs negatif 0,20 │ −0,09R.
- Lonjakan volume tinggi: datar di IS, 0,33 vs −0,22R di OOS.
- **Tidak konsisten:** ATR%, return 30 hari, OI 7 hari, posisi value area, jarak dari ATH.

**2 · Reversal: koin ≥ 30% di bawah high 30 hari** (P(naik 30% dulu) 29% │ 24%, P(turun 30% dulu) 29% │ 29%). Fitur yang konsisten:
- **Breadth tinggi** (≥ 69% semesta juga dalam drawdown): turun-dulu 26 │ 21%, 10 hari +3,2 │ +3,7%. Kejatuhan massal pulih lebih baik.
- **BTC kuat saat koin jatuh** (BTC > MA200 +16%): turun-dulu 28 │ 41%, 30 hari −5,1 │ **−15,8%**. Jatuh sendirian adalah jebakan.
- **Koin tua** (≥ 526 hari): turun-dulu 15 │ 25% vs koin muda 36 │ 37%.
- **OI turun ≥ 12% dalam 7 hari** (deleveraging selesai): turun-dulu 21 │ 25% vs OI naik 32 │ 33%.
- **Jauh di bawah ATH** (< −89%): turun-dulu 20 │ 26% vs dekat ATH 35 │ 33%.
- **Tidak konsisten:** ATR%, range, return 30 hari, posisi value area (30 hari), USDT.D.

**3 · Veto di bot** (biaya 0,2%, IS │ OOS):
- tanpa veto: +26,1 │ +32,8%, Calmar 1,92 │ 2,20;
- di bawah VA 30 hari: 1,86 │ 2,32;
- funding ≤ −0,05%: 1,90 │ 2,18;
- basis ≤ −0,6%: 1,95 │ 1,93;
- naik > 10%/24 jam: 1,92 │ 2,08;
- keempatnya: +26,6 │ +37,5%, Calmar 1,82 │ 2,32.
- Veto jarang terpicu di v1.2 (0,1–5,6%). "Naik > 10%" membuang 26% trade Setup A. ➖ **IS tidak membaik, sehingga tidak dipasang.**

**4 · Timing entry Setup A:**
- Pullback ke level breakout dalam 2 hari: 0,86 │ 1,21R per trade (vs breakout 0,81 │ 1,33R).
- Tapi 16% breakout tidak pernah pullback, dan itu sering pelari terbaik. Portofolio v1.2 + A pullback: Calmar 1,39 │ 1,94 (vs 1,92 │ 2,20); setengah-setengah: 1,75 │ 1,93. ❌ **Tetap beli saat breakout.**

**Catatan:** fitur di 1 dan 2 dipilih karena konsisten di IS dan OOS, jadi OOS sudah dipakai untuk memilih. Uji filter berdasarkan fitur ini butuh data baru (live) sebagai OOS yang bersih.

**Hipotesis terkunci (2026-10-11).** Bot mencatat ciri ini pada setiap entry (`bot/traits.ts`) tanpa mengubah keputusan. Hasilnya dibandingkan di laporan harian (rata-rata R dengan │ tanpa ciri). Ambang = batas tercile IS di atas, dan tidak boleh diubah.

| Setup | Ciri | Aturan |
|---|---|---|
| A | tight base | range 120 bar sebelum breakout < 16% dari harga |
| A | funding up | rata-rata 3 funding terakhir ≥ 0,01% |
| A | basis up | close 4h perp ≥ 0,042% di atas spot |
| v1 | mass drawdown | ≥ 69% pair yang dievaluasi ≥ 30% di bawah close tertinggi 30 hari |
| v1 | OI flushed | open interest turun ≥ 12,3% dalam 7 hari |
| v1 | mature coin | ≥ 526 hari riwayat (dihitung paling awal dari 2021-01-01) |
| v1 | BTC not hot | BTC < 16,5% di atas rata-rata 200 hari |

- **Evaluasi:** setelah ≥ 30 trade tertutup per setup (perkiraan 3–6 bulan). Sebuah ciri lolos kalau trade dengan ciri itu punya rata-rata R lebih tinggi dan selisihnya tidak hilang setelah 60 trade. Baru setelah itu ciri dipertimbangkan sebagai filter atau prioritas, dengan izin pemilik.

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

### Tahap 2: Research Lab di repo ✅ SELESAI (2026-10-03)
- [x] `research/` (data dari arsip Binance termasuk pair yang di-delist, semesta, backtest Setup v1). Bisa dijalankan ulang: `npm run research:setup-v1`.
- [x] Uji gabungan Stoch 5,3,3 OR 14,3,3 (lulus, lihat 4.4).
- [x] Semesta tanpa survivorship bias dan likuiditas pada waktu sinyal. Hasil: Setup v1 per trade positif, **portofolionya rugi** → **Setup v1.1** (filter breadth) dibuat dan lulus (lihat 4.5).
- [x] Bootstrap CI 95%. [ ] Walk-forward berlapis dan monte carlo drawdown (lanjutan).
- **Lulus:** Setup v1.1 positif per trade dan per portofolio di kedua periode, termasuk di koin yang sudah di-delist.

### Tahap 3: Fondasi server (VPS Singapura) ← kode bot siap; menunggu VPS
- [x] Service bot 24/7 (`bot/`), Docker + `docker-compose.yml`, panduan deploy di [BOT.md](BOT.md) §7.
- [x] Alert Telegram dan perintah kendali. Panel "Bot" di web app.
- [x] VPS 24/7: DigitalOcean Singapura (2 GB). Firewall hanya SSH, login hanya SSH key, fail2ban, swap, backup DB harian (14 hari). Bot dan web berjalan di Docker dengan restart otomatis. Web diakses lewat tunnel SSH. Semua endpoint Binance (spot, futures, testnet) bisa dijangkau dari IP Singapura.
- [ ] Collector: trade semua venue, bar buy/sell, order book untuk Tier A, OI, funding, likuidasi.
- [ ] Database time-series (ClickHouse), dengan pemantau kualitas data (celah, keterlambatan).
- [ ] Scanner pindah ke server, alert Telegram.
- [ ] Web app menjadi tampilan dari server (API + WebSocket).
- **Lulus:** 2 minggu data tanpa celah besar, alert Telegram tepat waktu.

### Tahap 4: Paper trading (bot tanpa uang) ← siap dijalankan
- [x] Engine eksekusi simulasi (`PaperBroker`): entry di close 4h, stop dari bar, exit sinyal, fee 0,1% per sisi + slippage.
- [x] Replay: bot dijalankan di atas data historis lewat kode yang sama dengan live. **Fidelitas 71/71 trade, 0 selisih.**
- [x] Jurnal (SQLite: posisi, event, equity) dan dashboard di panel Bot.
- [x] Mesin risiko: risiko per trade, maksimal posisi, cap per posisi, batas rugi harian, pause/kill switch, filter v1.1. [ ] Eksposur per sektor dan batas rugi mingguan (lanjutan).
- [ ] **Paper trading berjalan di VPS sejak 2026-10-03.** Evaluasi setelah ≥ 1–3 bulan atau ≥ 40 trade.
- **Lulus:** minimal 1–3 bulan atau ≥ 40 trade. Win rate dan expectancy dalam interval kepercayaan backtest. Tidak ada bug eksekusi.

### Tahap 5: Koneksi Binance, testnet lalu live kecil ← kode siap; menunggu API key testnet
- [x] **Pasar: Spot** (Setup v1 long-only: tanpa likuidasi dan funding).
- [x] Order manager (`bot/binance.ts`): market buy, stop dipasang di exchange (STOP_LOSS, atau STOP_LOSS_LIMIT dengan buffer 2%), exit, rekonsiliasi tiap menit, order idempotent (clientOrderId, dicek ulang setelah putus), pembulatan tick/step, fee dalam USDT, sinkronisasi jam server. Teruji dengan HTTP mock (17 unit test).
- [x] Kunci ganda mode live (`MODE=live` + frasa `LIVE_CONFIRM`). Panduan API key aman di [BOT.md](BOT.md) §5.
- [x] Uji eksekusi Binance Testnet (`npm run bot:testnet-check`): beli market, stop −15% terpasang di exchange, batal, jual, batal ulang. **Lulus**, dan pembukuan bot cocok dengan saldo Binance.
- [ ] Bot penuh dalam MODE=testnet (opsional, bisa paralel dengan paper) dan skenario restart di tengah posisi.
- [ ] Live dengan modal kecil dan risiko 0,25–0,5% per trade. Naik bertahap kalau metrik tetap sehat.
- **Lulus:** 1 bulan live tanpa selisih rekonsiliasi, slippage sesuai asumsi.

### Tahap 6: Operasi dan keamanan bot
- [x] Kill switch: `/pause`, `/resume`, `/flatten CONFIRM` (Telegram) dan pause/resume (API/panel). Batas rugi harian. Posisi tanpa stop tidak pernah dibiarkan (entry langsung dibatalkan).
- [x] Log audit setiap siklus dan keputusan (tabel events). Alert Telegram saat error. Shutdown tidak memotong siklus.
- [ ] Batas rugi mingguan, berhenti otomatis kalau data rusak, health check eksternal (lanjutan).
- [ ] Pemantauan pemudaran keunggulan: kalau performa live turun di bawah ambang, setup otomatis dinonaktifkan.

### Tahap 7: Lapisan data posisi → confluence, exposure, dan peringatan exit (DIRENCANAKAN 2026-10-04)
- [ ] OI, funding, likuidasi live, basis, Coinbase premium, kuadran harga×OI, perkiraan peta likuidasi.

**Gagasan (pemilik):** harga bergerak karena pembeli agresif. Pembeli agresif muncul karena melihat atau mengantisipasi sesuatu (informasi, posisi, FOMO). Jejaknya terlihat di data posisi derivatif dan aliran order. Data ini **bukan pemicu entry**. Dipakai sebagai **confluence** untuk setup yang sudah ada (v1.2, Setup A):
1. **Exposure:** memperbesar ukuran saat confluence mendukung, memperkecil saat bertentangan (misalnya 0,5× / 1× / 1,5× dari risiko dasar).
2. **Peringatan TP/SL:** tanda kepadatan atau kelelahan pasar selama posisi terbuka (blow-off funding, OI melonjak tapi harga tertahan). Awalnya hanya peringatan; exit otomatis hanya kalau terbukti (§4.13: exit cepat yang umum merugikan).

**Hipotesis yang akan diuji** (ditetapkan sebelum melihat hasil):

| Data | Untuk v1.2 (kapitulasi) | Untuk Setup A (breakout) | Peringatan selama posisi |
|---|---|---|---|
| Funding rate (dan z-score 30 hari) | Funding negatif = short ramai → bahan bakar squeeze → exposure naik | Funding sangat positif = long ramai → exposure turun | Funding melonjak ekstrem saat profit → peringatan TP |
| Open interest (perubahan 1/3/7 hari) | OI turun tajam saat harga jatuh = likuidasi sudah terjadi ("bersih") → exposure naik | OI naik bersama harga = uang baru → exposure naik; harga naik tapi OI turun = short covering saja → turun | OI melonjak tapi harga tertahan → peringatan |
| Taker buy/sell ratio (perp) dan volume delta | Penjual agresif mulai habis | Pembeli agresif dominan saat breakout | Pembeli agresif melemah di puncak |
| Rasio long/short (global dan top trader) | Ritel sangat short → kontrarian naik | Ritel sangat long → turun | Ritel menumpuk long saat profit → peringatan |
| Basis perp vs spot | Diskon perp = panik | Premium besar = spekulasi berlebihan | Premium melebar ekstrem → peringatan |
| Pengumuman Binance (delist, Monitoring, Seed) | Pengaman: jangan entry | Pengaman: jangan entry | Peringatan keluar |

**Rencana kerja:**

| Langkah | Isi | Tempat | Hasil |
|---|---|---|---|
| **F1 · Data historis** ✅ | Arsip futures Binance (data.binance.vision, **dicek 2026-10-04**): funding bulanan untuk **989 perp** (termasuk yang sudah di-delist, BTC sejak 2020-01); metrics harian per 5 menit berisi OI, nilai OI, rasio long/short top trader (akun & posisi), rasio long/short global, rasio volume taker long/short (BTC sejak 2020-09, mayoritas altcoin sejak **2021-12-01**, ±11 KB per hari per koin). Unduhan sekitar 300–350 ribu file kecil (beberapa jam), disimpan ringkas per bar 4h. Kline perp 4h untuk basis. Semua perp USDT yang cocok dengan semesta 653 pair, termasuk yang sudah di-delist. Diselaraskan ke close bar 4h tanpa melihat ke depan | Lokal (`research/futures.ts`, cache tidak di-commit) | Laporan cakupan: berapa trade v1.2/A yang punya data futures |
| **F2 · Fitur per trade** | Nilai saat entry dan selama posisi (funding, z-score, ΔOI, divergensi OI–harga, long/short, taker ratio, basis) | Lokal | Dataset fitur |
| **F3 · Diagnosis** | Tabel per kelompok IS │ OOS (seperti §4.7/§4.12) untuk entry; untuk peringatan: seberapa sering tanda muncul sebelum titik puncak vs sebelum SL | Lokal | Fitur mana yang konsisten di kedua periode |
| **F4 · Uji aturan** | Skor confluence (−1/0/+1 per fitur yang lulus F3) → pengali exposure; peringatan exit diuji sebagai TP sebagian. Dipilih di IS, dilaporkan di OOS, per tahun. Koin tanpa futures = netral (1×) | Lokal | Lulus/gagal per aturan, dibandingkan dengan v1.2 + A saat ini |
| **F5 · Implementasi (kalau lulus)** | Engine bersama → kolom/badge "Confluence" di scanner, panel OI/funding di chart, opsi pengali exposure di bot (default mati), peringatan Telegram (tanpa exit otomatis kecuali terbukti) | App + bot lokal | Paper lokal |
| **F6 · Collector ke depan** ✅ mulai 2026-10-06 | Rekam yang tidak punya riwayat gratis: likuidasi (stream `forceOrder`), snapshot orderbook, OI/funding live, pengumuman Binance, judul berita (RSS gratis) untuk diuji nanti | VPS (**perlu persetujuan**, ukuran disk dihitung dulu) | Data sendiri untuk uji 3–6 bulan lagi |
| **Pengaman delisting** ✅ 2026-10-05 | Bot tidak entry di pair yang akan di-delist / bertag Monitoring; posisi di pair yang diumumkan delisting dijual; scanner memberi label | Bot + scanner | Perlindungan |

**Aturan main:**
- Hipotesis dan arah efek ditetapkan sebelum melihat hasil. Ambang dipilih di IS saja.
- Minimal ±30 trade per kelompok.
- Jumlah uji dicatat. Karena banyak fitur diuji, hanya efek yang konsisten di kedua periode yang dipercaya.
- Hasil negatif dilaporkan apa adanya.
- **Batasan yang sudah diketahui:** hanya koin dengan perpetual Binance (sekitar 300+ dari 653 pair, umumnya yang lebih likuid). Riwayat metrics mulai sekitar akhir 2021, sehingga IS lebih pendek (kira-kira 2022 → 2024-06).

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
- ~~Stoch 5,3,3 vs 14,3,3 vs gabungan~~ → "either" (lulus kedua periode).
- Pasar bot pertama: Spot (rekomendasi untuk Setup v1) atau Futures.
- Saluran alert: Telegram.

**Rencana tertunda (disimpan 2026-10-04, menunggu keputusan pemilik):**

1. ~~**Setup A (breakout)** sebagai indikator di chart dan tab kedua di scanner~~ ✅ 2026-10-04: `lib/setups/setupA.ts` (identik dengan riset, 5.361/5.361 trade), indikator "Setup A", dan scanner dengan pilihan setup (Vol ×, RS vs BTC, Fear & Greed). Data kline diambil sekali per bar untuk kedua setup.
2. Setelah dinilai manual di chart: Setup A sebagai sleeve kedua bot (risiko 0,5%/trade), paper dulu.
3. v1.2: opsi `MAX_RISK_PER_BAR` di bot (§4.6).
4. Collector open interest di VPS (riwayat OI tidak tersedia > 30 hari).
5. ~~Panel kondisi pasar~~ ✅ 2026-10-04: chip di toolbar chart (Fear & Greed, BTC vs MA200 harian, breadth v1, jumlah breakout terkonfirmasi), klik untuk membuka scanner.

## 10. Catatan perubahan

- **2026-10-03:** Roadmap dibuat. Setup v1 ditetapkan dari riset 25 dan 99 pair. Mulai Tahap 1.
- **2026-10-03:** Tahap 1 selesai (engine, overlay, scanner, notifikasi). Uji Stoch gabungan: "either" lulus kedua periode dan dijadikan default. Berikutnya: Tahap 2 (Research Lab di repo, semesta tanpa survivorship bias).
- **2026-10-03:** Tahap 2 selesai. Uji tanpa survivorship bias (653 pair termasuk yang di-delist) membongkar bahwa keunggulan datang dari kapitulasi seluruh pasar → **Setup v1.1** (breadth ≥ 10, likuiditas ≥ $1M). Kode Tahap 3–6 selesai (bot: paper/testnet/live, risiko, Telegram, API, panel, Docker, replay 71/71). Menunggu: VPS, token Telegram, API key testnet.
- **2026-10-03:** Deploy di VPS (DigitalOcean Singapura). Bot paper berjalan 24/7 dengan Telegram. Uji eksekusi testnet lulus.
- **2026-10-03:** Riset upgrade v1.1 (H1–H8, lokal). Hanya H5 (batas risiko ≤ 5% per bar sinyal) yang lulus IS dan OOS: DD OOS −19,9% → −11,2%, CAGR sama. Kandidat v1.2; belum di server.
- **2026-10-04:** Riset tren dan strategi lain (§4.7). Breakout 20 hari + trailing 8×ATR positif di IS dan OOS dan menangkap ZEC +140%. Digabung dengan v1.2: positif setiap tahun, CAGR OOS +17%. Rotasi, 1h, dan pullback-in-trend gagal. Perbaikan loader riset: listing arsip yang error tidak lagi di-cache sebagai seri kosong.
- **2026-10-04:** Uji stochastic longgar (§4.8): cross < 30/40/50 tidak lebih baik di IS. Sinyal tambahan rugi di 2022 tapi kuat di 2024–2026. Tetap < 20; kandidat shadow-tracking. Rencana Setup A disimpan di §9.
- **2026-10-04:** Setup A di app: indikator overlay dan scanner (engine bersama, identik dengan riset). Indikator Stochastic ditambahkan. Bot tidak berubah.
- **2026-10-04:** Eksperimen v1 (§4.9): tanpa bias 1D dan breadth multi-candle sama-sama gagal. v1.2 tetap terbaik.
- **2026-10-04:** Token Telegram yang bocor sudah di-revoke (token lama 401) dan token baru terpasang di VPS. Riset modal bersama vs dibagi (§4.10): gabungan v1.2 + Setup A (risiko 0,5%) positif setiap tahun; pembagian modal tidak menentukan.
- **2026-10-04:** Bot mendukung beberapa setup: `SETUPS=v1,a`, `MAX_RISK_PER_BAR` (v1.2), `RISK_PER_TRADE_A`. Migrasi DB v2 (kolom `setup`). Fidelity replay: v1 71/71, A 59/59. Paper lokal v1.2 + A dengan modal $300 berjalan (`npm run bot:local`). Default tetap v1.1, jadi bot VPS tidak berubah.
- **2026-10-04:** Uji MaxFlow ± Stochastic di candle 1D tanpa breadth (§4.11): gagal, OOS −3,7% s/d −6,9% per trade.
- **2026-10-04:** Riset SL, breakeven, dan perbaikan entry (§4.12). SL ketat dan breakeven tidak membantu v1.2. Titik hijau pertama saja sedikit lebih baik. Setup A dengan filter RS vs BTC < −10% memangkas drawdown gabungan (−26 → −17% IS, −19 → −16% OOS) dengan profit sama atau lebih tinggi.
- **2026-10-04:** Riset exit pembalikan (§4.13): trade yang kena SL sempat untung (median +2,7% v1, +5% A), tapi semua aturan TP lebih awal memotong pemenang lebih banyak daripada menyelamatkan yang kalah. Tidak diterapkan.
- **2026-10-04:** Perbaikan entry §4.12 masuk ke bot sebagai opsi (default mati, bot VPS tidak berubah). Fidelity replay dengan opsi aktif: v1 64/64, A 12/12; default: 71/71, 59/59. Paper lokal: v1.2 (titik hijau pertama) + A (RS < −10%), $300.
- **2026-10-04:** Rencana Tahap 7 ditulis: data posisi (funding, OI, long/short, taker ratio, basis, pengumuman) sebagai confluence untuk exposure dan peringatan TP/SL, bukan pemicu entry. Langkah F1–F6.
- **2026-10-04:** Tahap 7 F1–F4 (§4.14): data futures diunduh (471 perp). Funding/OI/long-short/taker/basis tidak konsisten antar periode, sehingga tidak dipakai sebagai confluence. Bug breadth di bot (dengan `V1_FIRST_DOT_ONLY`) diperbaiki: breadth kembali dihitung dari semua sinyal v1.
- **2026-10-04:** Riset TP (§4.15): v1.2 tetap TP di titik merah pertama. Setup A: "perketat ke 5×ATR setelah +100%" dan "6×ATR, 10× kalau volume entry ≥ 3×" lebih baik di IS dan OOS. Exit volume klimaks gagal di gabungan.
- **2026-10-04:** Usulan pemilik diuji (§4.16): merapatkan trailing Setup A ke 4×ATR setelah lonjakan (candle hijau ≥ 3×ATR) memperbaiki gabungan di IS dan OOS (Calmar 1,40 → 1,99 │ 1,76 → 2,29, DD −18 → −14/−15%). Seluruh 18 varian lebih baik atau setara.
- **2026-10-04:** Trailing lonjakan §4.16 terpasang (engine, bot opsi `A_SPIKE_TIGHTEN`, indikator, scanner).
- **2026-10-04:** Uji pelonggaran entry dengan TP baru (§4.17): filter RS −10% tetap terbaik; makin longgar makin buruk (kecuali 2026).
- **2026-10-04:** Riset maksimalisasi (§4.18): re-entry, trailing 2×ATR, dan funding carry tidak membantu. Pyramiding Setup A di +1R (risiko 0,25%) menaikkan CAGR +27 → +33% (IS) dan +34 → +39% (OOS) dengan DD sedikit lebih dalam. Kandidat.
- **2026-10-04:** VPS diperbarui ke bot gabungan (paper $300): v1.2 titik hijau pertama + Setup A (RS < −10%, trailing lonjakan), konfigurasi sama dengan bot lokal. Database v1.1 (9 siklus, tanpa trade) diarsipkan di `/opt/backups/archive-v1.1-final-2026-10-04.sqlite`. Scanner di web VPS ikut diperbarui.
- **2026-10-05:** Dua bot di VPS: paper (testing) dan ops (testnet dulu, lalu live setelah key live dan konfirmasi pemilik). Panel Bot punya pilihan Paper / Ops.
- **2026-10-05:** Skenario eksekusi testnet lulus semua (`npm run bot:testnet-scenarios`): entry A + stop di exchange, restart, exit trailing, stop terisi, penjualan manual, pause/flatten. Ditemukan dan diperbaiki: koin yang sudah ada di akun bisa tercampur dengan posisi bot, sehingga sekarang pair seperti itu dilewati di testnet/live.
- **2026-10-05:** 🔴 **Bot Ops LIVE** di VPS atas keputusan pemilik: uji eksekusi dengan $98,60 USDT. Aturan sama dengan bot paper (v1.2 titik hijau pertama + Setup A RS < −10%, trailing lonjakan) plus `MIN_SIZE_MAX_RISK=0.015` untuk akun kecil. Key live: Spot only, withdrawal mati, IP VPS. Database testnet diarsipkan; backup harian mencakup database live. Siklus pertama: 463 pair, 0 error.
- **2026-10-05:** Pengaman peringatan Binance: jadwal delisting resmi (bot live) atau pengumuman (paper/scanner), dan tag Monitoring. Tidak entry, posisi yang akan di-delist dijual, label di scanner. Skenario testnet 8/8 lulus. Saat dipasang: STGUSDT dijadwalkan delisting 2026-10-06; 32 pair USDT bertag Monitoring.
- **2026-10-06:** MaxFlow + Stochastic saja di 1h (§4.19): keunggulan IS (+0,4% per trade kotor) hilang di OOS (sekitar 0%); semua portofolio rugi, bahkan di biaya futures maker. Tidak dipakai.
- **2026-10-06:** Uji 50% modal + SL 5% (bot 4h, §4.20) dan 1h dengan SL ≤ 5% / TP 1:2 / 50% modal (§4.21): keduanya gagal; bot tetap seperti sekarang.
- **2026-10-06:** Riset intraday 5m/15m (§4.24): sweep & reclaim dan ORB sesi tidak punya keunggulan sebelum biaya; gagal. Loader kline mendapat jalur cadangan tanpa listing.
- **2026-10-06:** Collector berjalan di VPS (likuidasi futures + orderbook spot 40 pair per menit). Diperbaiki: `.dockerignore` sekarang mengecualikan semua `bot/.env.*`, sehingga key tidak lagi ikut ke image Docker.
- **2026-10-06:** Celah stop ditemukan oleh pemilik: bot hanya mengenali stop yang FILLED. Stop yang dibatalkan, kedaluwarsa (termasuk setelah terisi sebagian), ditolak, atau tidak ditemukan kini ditangani (pasang ulang / jual sisa / jual market). 41 tes; skenario testnet 9 (stop dibatalkan di luar bot → dipasang ulang) lulus. Bot lokal di Mac dimatikan.
- **2026-10-06:** Laporan harian di Telegram (01:00 UTC / 08:00 WIB) + `/report`: tanda hidup bot, equity, posisi, aktivitas 24 jam, peringatan, dan kesehatan collector.
- **2026-10-06:** Strategi intraday usulan Gemini (VWAP + EMA20 + breakout + volume, 15m) diuji persis sesuai script-nya (§4.25): 0/140 kombinasi positif di IS maupun OOS. Gagal.
- **2026-10-06:** Perbaikan Gemini (ADX, tren 1h, retest, SL ATR) diuji (§4.26): 0/48 kombinasi positif setelah fee. Gagal.
- **2026-10-11:** Riset lanjutan §4.37–4.47: candle mingguan, audit bias (Setup A kokoh di semua timeframe; v1.2 rapuh), risk/reward, entry di titik SL, sapuan support, USDT dominance (+ MaxFlow), skrining koin harian, Setup C, uji kontrol harness, anatomi pemenang. Bot tidak diubah kecuali pencatatan ciri entry (`bot/traits.ts`, informasional) untuk menguji hipotesis §4.47 pada data live.
