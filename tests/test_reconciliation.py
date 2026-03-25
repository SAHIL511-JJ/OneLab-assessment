"""
Test Cases for Payment Reconciliation Engine
Verifies all 4 planted gap types are correctly detected.

Run with: pytest tests/test_reconciliation.py -v
"""

import json
import csv
import os
import sys
import pytest
from pathlib import Path

# Add project root to path so we can import scripts
PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "scripts"))

DATA_DIR = PROJECT_ROOT / "data"
OUTPUT_DIR = PROJECT_ROOT / "output"
REPORT_FILE = OUTPUT_DIR / "reconciliation_report.json"
TXN_FILE = DATA_DIR / "transactions.csv"
STL_FILE = DATA_DIR / "bank_settlements.csv"


# ── Fixtures ──────────────────────────────────────────────────────────

@pytest.fixture(scope="session", autouse=True)
def generate_and_reconcile():
    """Generate data and run reconciliation before all tests."""
    from generate_data import generate
    from reconcile import reconcile

    generate()
    reconcile()

    assert REPORT_FILE.exists(), "Reconciliation report was not generated"


@pytest.fixture(scope="session")
def report():
    """Load the reconciliation report."""
    with open(REPORT_FILE) as f:
        return json.load(f)


@pytest.fixture(scope="session")
def transactions():
    """Load raw transactions CSV."""
    with open(TXN_FILE) as f:
        return list(csv.DictReader(f))


@pytest.fixture(scope="session")
def settlements():
    """Load raw bank settlements CSV."""
    with open(STL_FILE) as f:
        return list(csv.DictReader(f))


# ── Test 1: Data Generation ──────────────────────────────────────────

class TestDataGeneration:
    def test_transactions_csv_exists(self):
        assert TXN_FILE.exists()

    def test_settlements_csv_exists(self):
        assert STL_FILE.exists()

    def test_transactions_have_expected_columns(self, transactions):
        expected = {
            "transaction_id", "order_id", "transaction_date", "amount",
            "currency", "payment_method", "status", "customer_email",
            "merchant_id", "fee", "tax", "net_amount"
        }
        actual = set(transactions[0].keys())
        assert expected.issubset(actual), f"Missing columns: {expected - actual}"

    def test_settlements_have_expected_columns(self, settlements):
        expected = {
            "settlement_id", "transaction_id", "utr", "settlement_date",
            "settlement_amount", "bank_reference", "status"
        }
        actual = set(settlements[0].keys())
        assert expected.issubset(actual), f"Missing columns: {expected - actual}"

    def test_transactions_row_count(self, transactions):
        # 300 normal + 3 cross-month + 5 rounding + 2 duplicates = 310
        assert len(transactions) == 310, f"Expected 310 rows, got {len(transactions)}"

    def test_settlements_row_count(self, settlements):
        # 300 normal + 3 cross-month + 5 rounding + 2 orphan refunds = 310
        assert len(settlements) == 310, f"Expected 310 rows, got {len(settlements)}"

    def test_all_amounts_are_valid(self, transactions):
        for txn in transactions:
            amount = float(txn["amount"])
            assert amount > 0, f"Invalid amount {amount} for {txn['transaction_id']}"
            assert float(txn["fee"]) > 0
            assert float(txn["tax"]) > 0
            assert float(txn["net_amount"]) > 0

    def test_currency_is_inr(self, transactions):
        for txn in transactions:
            assert txn["currency"] == "INR"


# ── Test 2: Cross-Month Settlements Detected ────────────────────────

class TestCrossMonthDetection:
    def test_cross_month_found(self, report):
        count = report["summary"]["cross_month"]
        assert count >= 3, f"Expected at least 3 cross-month, found {count}"

    def test_cross_month_have_different_months(self, report):
        for item in report["discrepancies"]["cross_month"]:
            txn_month = item["transaction_date"][:7]  # YYYY-MM
            stl_month = item["settlement_date"][:7]
            assert txn_month != stl_month, (
                f"{item['transaction_id']}: txn month {txn_month} == stl month {stl_month}"
            )

    def test_planted_cross_month_ids_detected(self, report):
        """The 3 specifically planted cross-month transactions should be detected."""
        cross_month_ids = {item["transaction_id"] for item in report["discrepancies"]["cross_month"]}
        planted = {"TXN_20250330_0301", "TXN_20250330_0302", "TXN_20250331_0303"}
        assert planted.issubset(cross_month_ids), (
            f"Planted cross-month IDs not found. Missing: {planted - cross_month_ids}"
        )


# ── Test 3: Rounding Errors Detected ────────────────────────────────

class TestRoundingErrors:
    def test_rounding_errors_found(self, report):
        count = report["summary"]["amount_mismatches"]
        assert count == 5, f"Expected exactly 5 rounding mismatches, found {count}"

    def test_rounding_differences_are_small(self, report):
        for item in report["discrepancies"]["amount_mismatches"]:
            diff = item["difference"]
            assert diff <= 0.10, (
                f"{item['transaction_id']}: difference ₹{diff} is too large for a rounding error"
            )

    def test_rounding_differences_are_nonzero(self, report):
        for item in report["discrepancies"]["amount_mismatches"]:
            assert item["difference"] > 0, (
                f"{item['transaction_id']}: difference is zero, should be nonzero"
            )


# ── Test 4: Duplicates Detected ──────────────────────────────────────

class TestDuplicateDetection:
    def test_duplicates_found_in_transactions(self, report):
        count = report["summary"]["duplicates_in_transactions"]
        assert count == 2, f"Expected 2 duplicate transaction groups, found {count}"

    def test_duplicate_ids_match_planted(self, report):
        dup_ids = {d["transaction_id"] for d in report["discrepancies"]["duplicates"]
                   if d["dataset"] == "transactions"}
        planted = {"TXN_20250317_0011", "TXN_20250319_0051"}
        assert planted == dup_ids, f"Expected {planted}, got {dup_ids}"

    def test_duplicate_occurrences_are_two(self, report):
        for dup in report["discrepancies"]["duplicates"]:
            if dup["dataset"] == "transactions":
                assert dup["occurrences"] == 2, (
                    f"{dup['transaction_id']}: expected 2 occurrences, got {dup['occurrences']}"
                )


# ── Test 5: Orphan Refunds Detected ─────────────────────────────────

class TestOrphanRefunds:
    def test_orphan_refunds_found(self, report):
        count = report["summary"]["orphan_refunds"]
        assert count == 2, f"Expected 2 orphan refunds, found {count}"

    def test_orphan_refund_ids_are_missing_from_transactions(self, report, transactions):
        txn_ids = {t["transaction_id"] for t in transactions}
        for orphan in report["discrepancies"]["orphan_refunds"]:
            assert orphan["transaction_id"] not in txn_ids, (
                f"{orphan['transaction_id']} exists in transactions but was flagged as orphan"
            )

    def test_orphan_refunds_have_negative_amounts(self, report):
        for orphan in report["discrepancies"]["orphan_refunds"]:
            assert orphan["settlement_amount"] < 0, (
                f"{orphan['transaction_id']}: amount {orphan['settlement_amount']} should be negative"
            )


# ── Test 6: Matched Count ───────────────────────────────────────────

class TestMatchedCount:
    def test_matched_count_is_reasonable(self, report):
        s = report["summary"]
        total_unique_txns = s["total_transactions"] - s["duplicates_in_transactions"]
        # Matched = unique txns that have settlements and are not cross-month or mismatched
        expected_matched = (
            total_unique_txns
            - s["cross_month"]
            - s["amount_mismatches"]
            - s["missing_settlements"]
        )
        assert s["matched"] == expected_matched, (
            f"Matched count {s['matched']} doesn't equal expected {expected_matched}"
        )


# ── Test 7: Report Structure ────────────────────────────────────────

class TestReportStructure:
    def test_report_has_summary(self, report):
        assert "summary" in report

    def test_report_has_discrepancies(self, report):
        assert "discrepancies" in report

    def test_report_has_all_transactions(self, report):
        assert "all_transactions" in report

    def test_summary_has_all_keys(self, report):
        required = {
            "total_transactions", "total_settlements", "matched",
            "cross_month", "amount_mismatches", "duplicates_in_transactions",
            "orphan_refunds",
        }
        assert required.issubset(set(report["summary"].keys()))

    def test_discrepancies_has_all_categories(self, report):
        required = {
            "cross_month", "amount_mismatches", "duplicates",
            "orphan_refunds",
        }
        assert required.issubset(set(report["discrepancies"].keys()))
