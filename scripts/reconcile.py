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
ROW_MISMATCH_TOLERANCE = 0.02

# Common date formats to try when parsing
DATE_FORMATS = [
    "%Y-%m-%d %H:%M:%S",  # 2025-03-15 14:30:00
    "%Y-%m-%d",            # 2025-03-15
    "%d-%m-%Y %H:%M:%S",  # 15-03-2025 14:30:00
    "%d-%m-%Y",            # 15-03-2025
    "%d/%m/%Y %H:%M:%S",  # 15/03/2025 14:30:00
    "%d/%m/%Y",            # 15/03/2025
    "%m/%d/%Y %H:%M:%S",  # 03/15/2025 14:30:00
    "%m/%d/%Y",            # 03/15/2025
    "%Y/%m/%d %H:%M:%S",  # 2025/03/15 14:30:00
    "%Y/%m/%d",            # 2025/03/15
    "%d %b %Y",            # 15 Mar 2025
    "%d %B %Y",            # 15 March 2025
    "%Y-%m-%dT%H:%M:%S",  # ISO format 2025-03-15T14:30:00
    "%Y-%m-%dT%H:%M:%SZ", # ISO with Z
]


def parse_date(date_string):
    """Try to parse a date string using multiple formats."""
    if not date_string or not date_string.strip():
        return None
    
    date_string = date_string.strip()
    
    for fmt in DATE_FORMATS:
        try:
            return datetime.strptime(date_string, fmt)
        except ValueError:
            continue
    
    # Try Python's ISO parser as a last resort (supports offsets like +05:30)
    try:
        return datetime.fromisoformat(date_string.replace("Z", "+00:00"))
    except ValueError:
        pass

    # If all formats fail, return None
    return None


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
    
    # Variance calculation: for ALL matched IDs (IDs found in both datasets)
    variance_expected_total = 0.0
    variance_actual_total = 0.0
    variance_pairs_count = 0
    
    # Separate tracking for "clean matched" (same month, within tolerance)
    clean_matched_expected = 0.0
    clean_matched_actual = 0.0
    clean_matched_count = 0
    tolerated_rounding_rows = 0

    for tid in sorted(matched_ids):
        txn = txn_map[tid]
        stl = stl_map[tid]

        txn_net = float(txn["net_amount"])
        stl_amt = float(stl["settlement_amount"])

        txn_date = parse_date(txn["transaction_date"])
        stl_date = parse_date(stl["settlement_date"])
        if txn_date is None:
            raise ValueError(
                f"Unsupported transaction_date format for {tid}: {txn['transaction_date']}"
            )
        if stl_date is None:
            raise ValueError(
                f"Unsupported settlement_date format for {tid}: {stl['settlement_date']}"
            )

        is_cross_month = txn_date.month != stl_date.month or txn_date.year != stl_date.year
        # Signed difference: positive = expected > actual (SHORT), negative = actual > expected (OVER)
        signed_diff = round(txn_net - stl_amt, 2)
        abs_diff = abs(signed_diff)
        has_mismatch = abs_diff > ROW_MISMATCH_TOLERANCE

        record = {
            "transaction_id": tid,
            "transaction_date": txn["transaction_date"],
            "settlement_date": stl["settlement_date"],
            "expected_amount": txn_net,
            "actual_amount": stl_amt,
            "difference": signed_diff,  # Signed for display (+/-)
            "payment_method": txn["payment_method"],
            "merchant_id": txn["merchant_id"],
            "order_id": txn["order_id"],
            "utr": stl["utr"],
        }

        # Add to variance totals for ALL matched IDs
        variance_expected_total += txn_net
        variance_actual_total += stl_amt
        variance_pairs_count += 1

        if is_cross_month:
            cross_month.append(record)
        elif has_mismatch:
            amount_mismatches.append(record)
        else:
            matched.append(record)
            clean_matched_expected += txn_net
            clean_matched_actual += stl_amt
            clean_matched_count += 1
            if 0 < abs_diff <= ROW_MISMATCH_TOLERANCE:
                tolerated_rounding_rows += 1

    # Round all totals
    variance_expected_total = round(variance_expected_total, 2)
    variance_actual_total = round(variance_actual_total, 2)
    total_variance = round(variance_expected_total - variance_actual_total, 2)
    
    clean_matched_expected = round(clean_matched_expected, 2)
    clean_matched_actual = round(clean_matched_actual, 2)
    clean_matched_variance = round(clean_matched_expected - clean_matched_actual, 2)

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
            "row_mismatch_tolerance": ROW_MISMATCH_TOLERANCE,
            # Variance for ALL matched IDs
            "variance_pairs_count": variance_pairs_count,
            "variance_expected_amount": variance_expected_total,
            "variance_actual_amount": variance_actual_total,
            "total_variance": total_variance,
            # Clean matched subset (same month, within tolerance)
            "clean_matched_count": clean_matched_count,
            "clean_matched_expected": clean_matched_expected,
            "clean_matched_actual": clean_matched_actual,
            "clean_matched_variance": clean_matched_variance,
            "tolerated_rounding_rows": tolerated_rounding_rows,
        },
        "discrepancies": {
            "cross_month": cross_month,
            "amount_mismatches": amount_mismatches,
            "duplicates": all_duplicates,
            "orphan_refunds": orphan_refunds,
            "missing_settlements": missing_settlements,
            "variance_breakdown": {
                "total_matched_ids": variance_pairs_count,
                "expected_total": variance_expected_total,
                "actual_total": variance_actual_total,
                "total_variance": total_variance,
                "clean_matched_variance": clean_matched_variance,
                "rows_with_tolerated_rounding": tolerated_rounding_rows,
                "row_tolerance": ROW_MISMATCH_TOLERANCE,
            },
        },
        "all_transactions": all_transactions,
    }

    # ── Write Report ────────────────────────────────────────────────
    with open(REPORT_FILE, "w") as f:
        json.dump(report, f, indent=2)

    # ── Print Summary ───────────────────────────────────────────────
    s = report["summary"]
    print("=" * 70)
    print("  RECONCILIATION REPORT")
    print("=" * 70)
    print(f"  Transactions loaded   : {s['total_transactions']} ({s['unique_transaction_ids']} unique)")
    print(f"  Settlements loaded    : {s['total_settlements']} ({s['unique_settlement_ids']} unique)")
    print("=" * 70)
    print()
    print("  💰 RECONCILIATION VARIANCE (Matched IDs Only)")
    print("  " + "-" * 66)
    print(f"  Matched ID Pairs      : {s['variance_pairs_count']} transactions")
    print(f"  Expected Amount       : ₹{s['variance_expected_amount']:,.2f}")
    print(f"  Actual Amount (Bank)  : ₹{s['variance_actual_amount']:,.2f}")
    print(f"  {'─' * 66}")
    variance_sign = "SHORT" if s['total_variance'] > 0 else "OVER" if s['total_variance'] < 0 else "BALANCED"
    print(f"  TOTAL VARIANCE        : ₹{abs(s['total_variance']):.2f} {variance_sign}")
    print()
    print("  📊 TRANSACTION BREAKDOWN (All Matched IDs)")
    print("  " + "-" * 66)
    print(f"  ✅ Clean Matched (same month, ≤tolerance) : {s['matched']}")
    print(f"  📅 Cross-Month                            : {s['cross_month']}")
    print(f"  💰 Amount Mismatches (>tolerance)         : {s['amount_mismatches']}")
    print(f"  🔢 Tolerated Rounding Rows                : {s['tolerated_rounding_rows']} (≤₹{s['row_mismatch_tolerance']:.2f} each)")
    print()
    print("  ⚠️  DATA QUALITY ISSUES (IDs not matched - excluded from variance)")
    print("  " + "-" * 66)
    print(f"  📋 Duplicate Transactions     : {s['duplicates_in_transactions']}")
    print(f"  📋 Duplicate Settlements      : {s['duplicates_in_settlements']}")
    print(f"  ❌ Missing Settlements        : {s['missing_settlements']}")
    print(f"  🔄 Orphan Refunds             : {s['orphan_refunds']}")
    print()
    print("=" * 70)
    print(f"  📄 Full report saved to: {REPORT_FILE}")
    print("=" * 70)


if __name__ == "__main__":
    reconcile()
