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

This creates `data/transactions.csv` (310 rows) and `data/bank_settlements.csv` (310 rows) with 4 planted discrepancy types.

### 3. Run Reconciliation

```bash
python scripts/reconcile.py
```

Outputs `output/reconciliation_report.json` with full discrepancy analysis.

### 4. Run Tests

```bash
pytest tests/test_reconciliation.py -v
```

### 5. View Dashboard

Open `dashboard/index.html` in your browser, or serve it locally:

```bash
cd /path/to/assess
python -m http.server 8080
# Then open http://localhost:8080/dashboard/
```

Click **"Use Sample Data"** → **"Run Reconciliation"** to see results.

---

## 📁 Project Structure

```
assess/
├── data/
│   ├── transactions.csv          # Platform transaction records
│   └── bank_settlements.csv      # Bank settlement records
├── scripts/
│   ├── generate_data.py          # Generates synthetic test data
│   └── reconcile.py              # Python reconciliation engine
├── dashboard/
│   ├── index.html                # Interactive dashboard
│   ├── style.css                 # Dark theme with glassmorphism
│   └── app.js                    # Client-side reconciliation + rendering
├── output/
│   └── reconciliation_report.json
├── tests/
│   └── test_reconciliation.py    # Automated test suite
└── README.md
```

---

## 📊 Planted Discrepancy Types

| # | Gap Type | Count | Description |
|---|----------|-------|-------------|
| 1 | **Cross-month settlement** | 3 | Transactions on March 30-31, settled in April 1-3 |
| 2 | **Rounding difference** | 5 | Fee/tax rounding produces ₹0.01-₹0.03 mismatches |
| 3 | **Duplicate entry** | 2 | Same transaction appearing twice in platform data |
| 4 | **Orphan refund** | 2 | Bank refunds referencing non-existent transactions |

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

## ⚠️ Production Limitations

1. Real bank settlement files come in varied formats (MT940, BAI2, CSV) — this tool assumes a clean CSV, so a production version would need format parsers and normalizers.
2. At scale (millions of transactions), client-side JS reconciliation would be too slow — a production system would need a backend with database-level joins and incremental reconciliation.
3. The matching logic uses only `transaction_id` — production systems need fuzzy matching on amount + date + reference when IDs are missing or formatted differently across systems.
