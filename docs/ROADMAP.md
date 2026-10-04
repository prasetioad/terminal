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
| **F6 · Collector ke depan** | Rekam yang tidak punya riwayat gratis: likuidasi (stream `forceOrder`), snapshot orderbook, OI/funding live, pengumuman Binance, judul berita (RSS gratis) untuk diuji nanti | VPS (**perlu persetujuan**, ukuran disk dihitung dulu) | Data sendiri untuk uji 3–6 bulan lagi |
| **Pengaman delisting** | Bot tidak entry di koin dengan pengumuman delist / tag Monitoring | Bot (bisa kapan saja) | Perlindungan |

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
