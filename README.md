# Payment Reconciliation Tool

A tool that reconciles payment platform transactions against bank settlement records, identifies discrepancies, and visualizes them in an interactive dashboard.

Built as part of the **OneLab AI Readiness Assessment**.

---

## 🚀 Quick Start

### Prerequisites
- Python 3.8+
- A modern browser (Chrome, Firefox, Safari, Edge)

### 1. Install Dependencies

```bash
pip install pandas pytest
```

### 2. Generate Test Data

```bash
python scripts/generate_data.py
```

This creates `data/transactions.csv` (318 rows) and `data/bank_settlements.csv` (318 rows) with 5 planted discrepancy types.

### 3. Run Reconciliation

```bash
python scripts/reconcile.py
```

Outputs `output/reconciliation_report.json` with full discrepancy analysis.

### 4. Run Tests

```bash
pytest tests/test_reconciliation.py -v
```

All 39 tests should pass, covering data generation, discrepancy detection, report structure, and date parsing.

### 5. View Dashboard

Open `dashboard/index.html` in your browser, or serve it locally:

```bash
python -m http.server 8080
# Then open http://localhost:8080/dashboard/
```

---

## 🧪 How to Test the Dashboard

### Option A: Use Sample Data (Quick Test)
1. Open `dashboard/index.html` in your browser
2. Click **"Use Sample Data"** to load pre-generated CSV files
3. Click **"Run Reconciliation"** to process
4. Explore the results in the tabs below

### Option B: Upload Your Own Files
1. Click **"Upload Transactions CSV"** and select your transactions file
2. Click **"Upload Settlements CSV"** and select your bank settlements file
3. Click **"Run Reconciliation"**

### Features to Test

| Feature | How to Test |
|---------|-------------|
| **Variance Calculation** | Check the "RECONCILIATION VARIANCE" section shows Expected, Actual, and Net Variance amounts |
| **Signed Differences** | In the "All Transactions" table, differences show `+` (red, SHORT) or `−` (green, OVER) |
| **Search** | Type in the search box to filter by Transaction ID, Order ID, Merchant, Payment Method, UTR, or Status |
| **Tab Navigation** | Click tabs: All Transactions, Cross-Month, Mismatches, Duplicates, Orphans |
| **Column Sorting** | Click column headers to sort (Transaction ID, Date, Expected, Actual, Difference) |
| **Tolerance Setting** | Adjust "Row Mismatch Tolerance" input and re-run reconciliation |
| **Legend** | Verify the +/− legend explains SHORT (bank paid less) and OVER (bank paid more) |

### Expected Results with Sample Data

| Metric | Expected Value |
|--------|----------------|
| Total Transactions | 318 (316 unique) |
| Matched ID Pairs | 316 |
| Cross-Month | 15 (includes 3 planted) |
| Amount Mismatches | 8 |
| Duplicates | 2 |
| Orphan Refunds | 2 |
| Tolerated Rounding | 5 rows |
| Net Variance | ~₹7.95 OVER |

---

## 📁 Project Structure

```
OneLab-assessment/
├── data/
│   ├── transactions.csv          # Platform transaction records
│   └── bank_settlements.csv      # Bank settlement records
├── scripts/
│   ├── generate_data.py          # Generates synthetic test data
│   └── reconcile.py              # Python reconciliation engine
├── dashboard/
│   ├── index.html                # Interactive dashboard
│   ├── style.css                 # Light sage/beige dashboard theme
│   └── app.js                    # Client-side reconciliation + rendering
├── output/
│   └── reconciliation_report.json
├── tests/
│   └── test_reconciliation.py    # Automated test suite (39 tests)
└── README.md
```

---

## 📊 Planted Discrepancy Types

| # | Gap Type | Count | Description |
|---|----------|-------|-------------|
| 1 | **Cross-month settlement** | 3 | Transactions on March 30-31, settled in April 1-3 |
| 2 | **Rounding difference (aggregate)** | 5 rows | Tiny ₹0.01 drift per row is tolerated; gap appears when totals are summed |
| 3 | **Duplicate entry** | 2 | Same transaction appearing twice in platform data |
| 4 | **Orphan refund** | 2 | Bank refunds referencing non-existent transactions |
| 5 | **Amount mismatches (bidirectional)** | 8 | Larger differences (₹2-7) with both SHORT and OVER directions |

---

## 📋 Stated Assumptions

1. All transactions are in **INR**
2. Bank settles **1–2 business days** after transaction
3. Platform fee = **2% of amount**, Tax = **18% GST** on fee
4. Reconciliation period: **March 2025**
5. `transaction_id` is the **primary matching key** across datasets
6. `net_amount = amount - fee - tax` should equal bank's `settlement_amount`
7. Refunds appear as **negative amounts** in bank settlements
8. Duplicates can occur on either side due to **system retries**

---

## 📐 Variance Calculation Logic

**Variance** = Total Expected Amount − Total Actual Amount

- **Included in variance**: All transactions where the ID exists in BOTH datasets (matched, cross-month, amount mismatches)
- **Excluded from variance**: Orphan refunds, missing settlements, duplicates (IDs don't match)

| Sign | Meaning | Color |
|------|---------|-------|
| `+` | SHORT — Bank paid **less** than expected | Red |
| `−` | OVER — Bank paid **more** than expected | Green |

---

## ⚠️ Production Limitations

1. Real bank settlement files come in varied formats (MT940, BAI2, CSV) — this tool assumes a clean CSV, so a production version would need format parsers and normalizers.
2. At scale (millions of transactions), client-side JS reconciliation would be too slow — a production system would need a backend with database-level joins and incremental reconciliation.
3. The matching logic uses only `transaction_id` — production systems need fuzzy matching on amount + date + reference when IDs are missing or formatted differently across systems.
