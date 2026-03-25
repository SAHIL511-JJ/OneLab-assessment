"""
Reconciliation Engine for Payment Reconciliation Assessment
Reads transactions.csv and bank_settlements.csv, matches them,
identifies all discrepancies, and outputs a structured JSON report.
"""

import csv
import json
import os
from collections import Counter
from datetime import datetime
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
OUTPUT_DIR = Path(__file__).resolve().parent.parent / "output"

TXN_FILE = DATA_DIR / "transactions.csv"
STL_FILE = DATA_DIR / "bank_settlements.csv"
REPORT_FILE = OUTPUT_DIR / "reconciliation_report.json"


def load_csv(filepath):
    """Load a CSV file into a list of dicts."""
    with open(filepath, "r") as f:
        reader = csv.DictReader(f)
        return list(reader)


def find_duplicates(rows, key_field, dataset_name):
    """Find rows with duplicate values for the given key field."""
    counter = Counter(row[key_field] for row in rows)
    duplicate_keys = {k for k, v in counter.items() if v > 1}

    duplicates = []
    for key in sorted(duplicate_keys):
        count = counter[key]
        matching_rows = [row for row in rows if row[key_field] == key]
        duplicates.append({
            "transaction_id": key,
            "occurrences": count,
            "dataset": dataset_name,
            "rows": matching_rows,
        })

    return duplicates, duplicate_keys


def reconcile():
    """Run full reconciliation and produce report."""
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    # ── Load Data ───────────────────────────────────────────────────
    transactions = load_csv(TXN_FILE)
    settlements = load_csv(STL_FILE)

    # ── 1. Detect Duplicates ────────────────────────────────────────
    txn_duplicates, txn_dup_keys = find_duplicates(transactions, "transaction_id", "transactions")
    stl_duplicates, stl_dup_keys = find_duplicates(settlements, "transaction_id", "bank_settlements")

    all_duplicates = txn_duplicates + stl_duplicates

    # ── 2. Build Lookup Maps (deduplicated) ─────────────────────────
    # For matching, use first occurrence of each transaction_id
    txn_map = {}
    for row in transactions:
        tid = row["transaction_id"]
        if tid not in txn_map:
            txn_map[tid] = row

    stl_map = {}
    for row in settlements:
        tid = row["transaction_id"]
        if tid not in stl_map:
            stl_map[tid] = row

    all_txn_ids = set(txn_map.keys())
    all_stl_ids = set(stl_map.keys())

    # ── 3. Find Orphan Refunds (in settlements, not in transactions) ─
    orphan_ids = all_stl_ids - all_txn_ids
    orphan_refunds = []
    for tid in sorted(orphan_ids):
        stl = stl_map[tid]
        orphan_refunds.append({
            "settlement_id": stl["settlement_id"],
            "transaction_id": tid,
            "settlement_amount": float(stl["settlement_amount"]),
            "settlement_date": stl["settlement_date"],
            "utr": stl["utr"],
            "bank_reference": stl["bank_reference"],
        })

    # ── 4. Find Missing Settlements (in transactions, not in settlements)
    missing_settlement_ids = all_txn_ids - all_stl_ids
    missing_settlements = []
    for tid in sorted(missing_settlement_ids):
        txn = txn_map[tid]
        missing_settlements.append({
            "transaction_id": tid,
            "transaction_date": txn["transaction_date"],
            "amount": float(txn["amount"]),
            "net_amount": float(txn["net_amount"]),
            "status": txn["status"],
        })

    # ── 5. Match and Compare ────────────────────────────────────────
    matched_ids = all_txn_ids & all_stl_ids
    cross_month = []
    amount_mismatches = []
    matched = []

    for tid in sorted(matched_ids):
        txn = txn_map[tid]
        stl = stl_map[tid]

        txn_net = float(txn["net_amount"])
        stl_amt = float(stl["settlement_amount"])

        txn_date = datetime.strptime(txn["transaction_date"], "%Y-%m-%d %H:%M:%S")
        stl_date = datetime.strptime(stl["settlement_date"], "%Y-%m-%d")

        is_cross_month = txn_date.month != stl_date.month or txn_date.year != stl_date.year
        amount_diff = round(abs(txn_net - stl_amt), 2)
        has_mismatch = amount_diff > 0.001

        record = {
            "transaction_id": tid,
            "transaction_date": txn["transaction_date"],
            "settlement_date": stl["settlement_date"],
            "expected_amount": txn_net,
            "actual_amount": stl_amt,
            "difference": amount_diff,
            "payment_method": txn["payment_method"],
            "merchant_id": txn["merchant_id"],
            "order_id": txn["order_id"],
            "utr": stl["utr"],
        }

        if is_cross_month:
            cross_month.append(record)
        elif has_mismatch:
            amount_mismatches.append(record)
        else:
            matched.append(record)

    # ── 6. Build Full Transaction List with Status ──────────────────
    all_transactions = []

    # Matched
    for r in matched:
        r_copy = r.copy()
        r_copy["status"] = "MATCHED"
        all_transactions.append(r_copy)

    # Cross-month
    for r in cross_month:
        r_copy = r.copy()
        r_copy["status"] = "CROSS_MONTH"
        all_transactions.append(r_copy)

    # Amount mismatch
    for r in amount_mismatches:
        r_copy = r.copy()
        r_copy["status"] = "AMOUNT_MISMATCH"
        all_transactions.append(r_copy)

    # Missing settlements
    for r in missing_settlements:
        r_copy = r.copy()
        r_copy["status"] = "MISSING_SETTLEMENT"
        all_transactions.append(r_copy)

    # Orphan refunds
    for r in orphan_refunds:
        r_copy = r.copy()
        r_copy["status"] = "ORPHAN_REFUND"
        all_transactions.append(r_copy)

    # Sort by transaction_date where available
    all_transactions.sort(key=lambda x: x.get("transaction_date", x.get("settlement_date", "")))

    # ── 7. Build Report ─────────────────────────────────────────────
    report = {
        "summary": {
            "total_transactions": len(transactions),
            "total_settlements": len(settlements),
            "unique_transaction_ids": len(all_txn_ids),
            "unique_settlement_ids": len(all_stl_ids),
            "matched": len(matched),
            "cross_month": len(cross_month),
            "amount_mismatches": len(amount_mismatches),
            "duplicates_in_transactions": len(txn_duplicates),
            "duplicates_in_settlements": len(stl_duplicates),
            "missing_settlements": len(missing_settlements),
            "orphan_refunds": len(orphan_refunds),
        },
        "discrepancies": {
            "cross_month": cross_month,
            "amount_mismatches": amount_mismatches,
            "duplicates": all_duplicates,
            "orphan_refunds": orphan_refunds,
            "missing_settlements": missing_settlements,
        },
        "all_transactions": all_transactions,
    }

    # ── Write Report ────────────────────────────────────────────────
    with open(REPORT_FILE, "w") as f:
        json.dump(report, f, indent=2)

    # ── Print Summary ───────────────────────────────────────────────
    s = report["summary"]
    print("=" * 60)
    print("  RECONCILIATION REPORT")
    print("=" * 60)
    print(f"  Transactions loaded   : {s['total_transactions']} ({s['unique_transaction_ids']} unique)")
    print(f"  Settlements loaded    : {s['total_settlements']} ({s['unique_settlement_ids']} unique)")
    print("-" * 60)
    print(f"  ✅ Matched            : {s['matched']}")
    print(f"  📅 Cross-month        : {s['cross_month']}")
    print(f"  💰 Amount mismatches  : {s['amount_mismatches']}")
    print(f"  📋 Duplicate txns     : {s['duplicates_in_transactions']}")
    print(f"  📋 Duplicate stls     : {s['duplicates_in_settlements']}")
    print(f"  ❌ Missing settlements : {s['missing_settlements']}")
    print(f"  🔄 Orphan refunds     : {s['orphan_refunds']}")
    print("-" * 60)
    print(f"  Report saved to       : {REPORT_FILE}")
    print("=" * 60)


if __name__ == "__main__":
    reconcile()
