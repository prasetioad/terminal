# Dokumentasi Teknis & Panduan Penggunaan
## **MaxFlow+ Ultimate (5-in-1 Engine)**

---

## 1. Pendahuluan & Ringkasan Indikator

**MaxFlow+ Ultimate** adalah indikator analisis teknikal tingkat lanjut (*multi-faceted oscillator*) yang dirancang khusus untuk platform TradingView menggunakan Pine Script v5. Indikator ini mengintegrasikan lima algoritma utama ke dalam satu panel terpadu di bawah *chart* untuk membantu *trader* mengidentifikasi titik pembalikan harga (*reversal*), penguatan tren (*continuation*), serta mengukur arus volume dan momentum secara presisi.

### **Fitur Utama Engine:**
1. **Adaptive WaveTrend Oscillator:** Algoritma осilator responsif untuk mendeteksi kondisi *Overbought* (jenuh beli) dan *Oversold* (jenuh jual).
2. **Multi-Timeframe (MTF) Trend Bias:** Saringan tren otomatis dari *timeframe* yang lebih tinggi untuk meminimalkan *false signal*.
3. **Dynamic Volatility Bands (ATR-Based):** Garis limit sensitif yang otomatis melebar saat volatilitas tinggi untuk mencegah perangkap pasar (*market trap*).
4. **Volume Area & Dynamic POC (Point of Control):** Indikator arus uang (*Money Flow*) beserta level volume dominannya (garis POC).
5. **Auto Divergence & Pre-Signal Early Warning:** Deteksi otomatis *Regular* & *Hidden Divergence* serta sinyal peringatan awal (*small dots*).

Selain lima fitur di atas, panel juga selalu menampilkan **VWAP Wave**: jarak harga terhadap VWAP harian, sebagai area abu-abu.

---

## 2. Arsitektur Algoritma & Perhitungan Matematika

Seluruh perhitungan matematika dalam indikator menggunakan formulasi berbasis LaTeX untuk memastikan ketepatan teoritis.

### **2.1. Adaptive WaveTrend Engine**
WaveTrend mengukur deviasi harga tipikal ($HLC/3$) terhadap rata-rata pergerakannya.

1. **Harga Tipikal ($src$):**
   $$src = \frac{\text{High} + \text{Low} + \text{Close}}{3}$$

2. **Exponential Moving Average ($esa$) & Deviasi Mutlak ($d$):**
   $$esa = \text{EMA}(src, N_{\text{channel}})$$
   $$d = \text{EMA}(|src - esa|, N_{\text{channel}})$$

3. **Commodity Index ($ci$):**
   $$ci = \frac{src - esa}{0.015 \times d}$$

4. **Garis Gelombang Utama ($WT_1$) & Garis Sinyal ($WT_2$):**
   $$WT_1 = \text{EMA}(ci, N_{\text{average}})$$
   $$WT_2 = \text{SMA}(WT_1, 4)$$

---

### **2.2. Dynamic Volatility Bands (ATR-based)**
Batas ekstrem *Overbought* dan *Oversold* tidak bersifat kaku, melainkan beradaptasi dengan volatilitas relatif terhadap harga penutupan.

1. **Normalisasi ATR ($\text{ATR}_{\text{norm}}$):**
   $$\text{ATR}_{\text{norm}} = \left( \frac{\text{ATR}(L_{\text{ATR}})}{\text{Close}} \right) \times 100$$

2. **Pengali Volatilitas Dinamis ($M_{\text{dynamic}}$):**
   $$M_{\text{dynamic}} = \max(1.0, \text{ATR}_{\text{norm}} \times 0.5)$$

3. **Level Limit Dinamis ($Dev_{\text{Upper}}$ & $Dev_{\text{Lower}}$):**
   $$Dev_{\text{Upper}} = Base_{\text{Upper}} \times M_{\text{dynamic}}$$
   $$Dev_{\text{Lower}} = Base_{\text{Lower}} \times M_{\text{dynamic}}$$

---

### **2.3. Money Flow & Dynamic POC Volume Engine**
Menggabungkan *RSI berbasis volume* dan smoothing untuk mengukur kekuatan pembeli vs penjual.

1. **Money Flow RSI ($MF_{\text{RSI}}$):**
   $$MF_{\text{RSI}} = \text{RSI}(src \times \text{Volume}, L_{\text{MFI}}) - 50$$

2. **Money Flow Smooth ($MF$):**
   $$MF = \text{SMA}(MF_{\text{RSI}}, S_{\text{MFI}}) \times 1.5$$

3. **Dynamic POC Level ($POC_{\text{vol}}$):**
   $$POC_{\text{vol}} = \text{EMA}(MF, 20)$$

---

### **2.3b. VWAP Wave Engine**
Mengukur seberapa jauh harga penutupan dari VWAP yang di-*anchor* ke awal hari (00:00 UTC untuk pasar kripto).

1. **VWAP Harian:**
   $$VWAP = \frac{\sum (src \times \text{Volume})}{\sum \text{Volume}} \quad \text{(direset setiap hari)}$$

2. **Selisih Persentase:**
   $$VWAP_{\text{diff}} = \frac{\text{Close} - VWAP}{VWAP} \times 100$$

3. **Osilator VWAP:**
   $$VWAP_{\text{osc}} = \text{EMA}(VWAP_{\text{diff}}, L_{\text{VWAP}}) \times 6$$

Default $L_{\text{VWAP}} = 8$. Area di atas nol berarti harga di atas VWAP hari itu, dan sebaliknya.

---

### **2.4. Multi-Timeframe (MTF) Trend Bias**
Menghitung WaveTrend ($WT_1$) di *Higher Timeframe* ($HTF$) melalui `request.security` (dengan `gaps=barmerge.gaps_off`):

$$HTF_{\text{Bullish}} = WT_{1, HTF} \ge 0$$

* Jika $HTF_{\text{Bullish}} = \text{true}$, latar belakang panel berwarna **Hijau** (Bias Naik).
* Jika $HTF_{\text{Bullish}} = \text{false}$, latar belakang panel berwarna **Merah** (Bias Turun).

---

### **2.5. Auto Divergence Engine**
Divergence dideteksi berdasarkan pengujian titik *Pivot Low* ($PL$) dan *Pivot High* ($PH$) menggunakan *lookback period* ($lbL = 5, lbR = 5$).

* **Regular Bullish Divergence:**
  $$\text{Price}_{\text{Low}} < \text{Price}_{\text{PrevLow}} \quad \text{dan} \quad PL > PL_{\text{Prev}} \quad \text{dan} \quad WT_1 < 0$$
* **Hidden Bullish Divergence:**
  $$\text{Price}_{\text{Low}} > \text{Price}_{\text{PrevLow}} \quad \text{dan} \quad PL < PL_{\text{Prev}} \quad \text{dan} \quad WT_1 < 0$$
* **Regular Bearish Divergence:**
  $$\text{Price}_{\text{High}} > \text{Price}_{\text{PrevHigh}} \quad \text{dan} \quad PH < PH_{\text{Prev}} \quad \text{dan} \quad WT_1 > 0$$
* **Hidden Bearish Divergence:**
  $$\text{Price}_{\text{High}} < \text{Price}_{\text{PrevHigh}} \quad \text{dan} \quad PH > PH_{\text{Prev}} \quad \text{dan} \quad WT_1 > 0$$

---

### **2.6. Sinyal Titik (Main Dots & Early Warning)**
Semua titik di-plot pada nilai $WT_1$ bar sebelumnya (`offset = -1`).

* **Main Red Dot:** $WT_1$ memotong $WT_2$ ke bawah, $WT_1 > 0$, $WT_{1}[1] \ge Dev_{\text{Upper}}$ (jika filter OB/OS aktif), dan bias HTF tidak bullish (jika MTF aktif).
* **Main Green Dot:** $WT_1$ memotong $WT_2$ ke atas, $WT_1 < 0$, $WT_{1}[1] \le Dev_{\text{Lower}}$ (jika filter OB/OS aktif), dan bias HTF bullish (jika MTF aktif).
* **Early Warning (Orange):** perpotongan $WT_1$/$WT_2$ **ke arah mana pun** (`ta.cross`) dengan $0 < WT_1 < Dev_{\text{Upper}}$, dan bukan Main Red Dot.
* **Early Warning (Aqua):** perpotongan $WT_1$/$WT_2$ **ke arah mana pun** dengan $Dev_{\text{Lower}} < WT_1 < 0$, dan bukan Main Green Dot.

> Karena early warning tidak memeriksa arah perpotongan, titik oranye juga bisa muncul saat momentum berbalik **naik** di atas nol, dan titik aqua saat momentum berbalik **turun** di bawah nol. Baca arah histogram $WT_1$ untuk mengetahui arahnya.

---

## 3. Panduan Parameter Input & Pengaturan

| Nama Parameter | Tipe Data | Nilai Default | Deskripsi & Fungsi |
| :--- | :--- | :--- | :--- |
| **Trading Mode Preset** | Options | `Swing / Standard` | Memilih antara mode *Scalping (Fast)* (lebih sensitif) atau *Swing / Standard* (lebih stabil). |
| **Filter Dots by OB/OS** | Boolean | `true` | Jika aktif, titik sinyal utama hanya muncul jika perpotongan terjadi di atas/bawah batas ekstrem. |
| **Enable Auto Divergence** | Boolean | `true` | Menampilkan atau menyembunyikan penanda segitiga *Divergence*. |
| **Include Hidden Div** | Boolean | `true` | Menampilkan *Hidden Divergence* sebagai penanda kelanjutan tren (*continuation*). |
| **Enable MTF Trend Bias** | Boolean | `true` | Mengaktifkan warna latar belakang sebagai indikator bias tren timeframe atas. |
| **Higher Timeframe (HTF)**| Timeframe| `60` (1 Jam) | Resolusi timeframe atas yang digunakan untuk menghitung bias tren. |
| **Enable Dynamic Bands** | Boolean | `false` | Memungkinkan garis batas limit $Dev_{\text{Upper/Lower}}$ melar berbasis ATR. |
| **Enable Volume Area & POC**| Boolean| `true` | Menampilkan garis POC oranye. Area *Money Flow* selalu tampil, apa pun nilai toggle ini. |
| **Enable Early Warning** | Boolean | `true` | Menampilkan titik kecil (*pre-signal*) sebelum sinyal utama terbentuk. |

---

## 4. Interpretasi Visual & Sinyal Trading

```
+-----------------------------------------------------------------------+
|  [Background Tint: Green (HTF Bullish) / Red (HTF Bearish)]           |
|                                                                       |
|  ~~~~~~~ Dynamic Upper Limit (DevUpper) ~~~~~~~~~~~~~~~~~~~~~~~~~~~   |
|         🔴 Main Red Dot (Sell/Short)                                  |
|         🔸 Orange Small Dot (Pre-Signal)                              |
|       / \                                                             |
|      /   \  Histogram Kuning (WT1) & Biru (WT2)                      |
|  ------------------ Zero Level (0) ---------------------------------- |
|     /     \                                                           |
|    /       \                                                          |
|         🔹 Aqua Small Dot (Pre-Signal)                                |
|         🟢 Main Green Dot (Buy/Long)                                  |
|  ~~~~~~~ Dynamic Lower Limit (DevLower) ~~~~~~~~~~~~~~~~~~~~~~~~~~~   |
|                                                                       |
|  ━━━ Garis Dynamic POC Volume (Orange Line, di belakang histogram)   |
|  ░░░ Area Money Flow (Green = Positive / Red = Negative)             |
|                                                                       |
|  ▲ Regular/Hidden Bullish Div    ▼ Regular/Hidden Bearish Div        |
+-----------------------------------------------------------------------+
```

### **4.1. SOP Entry Long (Buy)**
1. **Filter Bias:** Latar belakang chart berwarna **Hijau** (MTF Trend Bias = Bullish).
2. **Peringatan Awal:** Terlihat titik kecil berwarna **Aqua** (Pre-signal) di bawah area Zero.
3. **Eksekusi:** Muncul **Main Green Dot** (titik hijau besar) di bawah garis limit bawah ($Dev_{\text{Lower}}$).
4. **Konfirmasi Tambahan (Optional):**
   * Muncul segitiga hijau terang ($\Delta$) penanda *Regular Bullish Divergence*.
   * Histogram $WT_1$ berada di atas garis **POC Dynamic Level** (garis oranye).

### **4.2. SOP Entry Short (Sell)**
1. **Filter Bias:** Latar belakang chart berwarna **Merah** (MTF Trend Bias = Bearish).
2. **Peringatan Awal:** Terlihat titik kecil berwarna **Orange** (Pre-signal) di atas area Zero.
3. **Eksekusi:** Muncul **Main Red Dot** (titik merah besar) di atas garis limit atas ($Dev_{\text{Upper}}$).
4. **Konfirmasi Tambahan (Optional):**
   * Muncul segitiga merah terang ($\nabla$) penanda *Regular Bearish Divergence*.
   * Area *Money Flow* berwarna merah dan memotong ke bawah level POC.

---

## 5. Panduan Praktis: Scalping vs. Swing Trading

| Strategi | Timeframe Chart | Setting HTF Bias | Preset Indicator | Catatan Operasional |
| :--- | :--- | :--- | :--- | :--- |
| **Scalping (Fast)** | 1m - 5m | `15` atau `60` | `Scalping (Fast)` | Fokus pada respon cepat. Aktifkan *Dynamic Bands* jika volatilitas pasar sedang sangat tinggi (misal saat *news release*). |
| **Swing Trading** | 1H - 4H | `D` (Daily) | `Swing / Standard` | Abaikan *small dots*, fokus hanya pada *Main Green/Red Dots* yang didukung *Regular Divergence*. |

---

## 6. Quick Reference Cheat Sheet

* 🟢 **Main Green Dot:** Sinyal validasi untuk **BUY / LONG**.
* 🔴 **Main Red Dot:** Sinyal validasi untuk **SELL / SHORT**.
* 🔹 **Aqua Small Dot:** Perpotongan $WT_1$/$WT_2$ di bawah nol (di atas limit bawah), ke arah mana pun. Perhatikan arah histogram untuk membacanya.
* 🔸 **Orange Small Dot:** Perpotongan $WT_1$/$WT_2$ di atas nol (di bawah limit atas), ke arah mana pun.
* 🟢 **Background Hijau:** Hanya cari setup **LONG** (Tren HTF Bullish).
* 🔴 **Background Merah:** Hanya cari setup **SHORT** (Tren HTF Bearish).
* ▲ **Segitiga Hijau:** *Bullish Divergence* (Potensi pembalikan harga naik).
* ▼ **Segitiga Merah:** *Bearish Divergence* (Potensi pembalikan harga turun).
* ━━ **Garis Oranye (POC):** Level dinamika volume. Jika histogram di atas garis ini, dorongan tren didukung volume kuat.