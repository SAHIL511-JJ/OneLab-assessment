"""
Synthetic Data Generator for Payment Reconciliation Assessment
Generates transactions.csv and bank_settlements.csv with 4 planted gap types:
  1. Cross-month settlement (March transactions settled in April)
  2. Rounding differences (floating-point fee/tax rounding)
  3. Duplicate entries (system retry duplicates in transactions)
  4. Orphan refunds (bank refunds with no matching transaction)
"""

import csv
import random
import os
from datetime import datetime, timedelta
from pathlib import Path

# ── Config ──────────────────────────────────────────────────────────────
SEED = 42
NUM_NORMAL_TRANSACTIONS = 300
RECONCILIATION_MONTH = 3  # March 2025
RECONCILIATION_YEAR = 2025
OUTPUT_DIR = Path(__file__).resolve().parent.parent / "data"

PAYMENT_METHODS = ["UPI", "Credit Card", "Debit Card", "NetBanking", "Wallet"]
PAYMENT_METHOD_WEIGHTS = [40, 25, 15, 12, 8]  # realistic distribution

MERCHANT_IDS = [f"MERCH_{str(i).zfill(3)}" for i in range(1, 21)]  # 20 merchants
BANK_PREFIXES = ["HDFC", "ICICI", "SBI", "AXIS", "KOTAK"]

random.seed(SEED)

# ── Helpers ─────────────────────────────────────────────────────────────

def random_datetime_in_march():
    """Random datetime in March 2025."""
    start = datetime(2025, 3, 1, 8, 0, 0)
    end = datetime(2025, 3, 31, 22, 0, 0)
    delta = end - start
    random_seconds = random.randint(0, int(delta.total_seconds()))
    return start + timedelta(seconds=random_seconds)


def random_amount():
    """Random realistic transaction amount between ₹50 and ₹25,000."""
    # Mix of small and large transactions
    if random.random() < 0.6:
        return round(random.uniform(50, 2000), 2)
    elif random.random() < 0.85:
        return round(random.uniform(2000, 10000), 2)
    else:
        return round(random.uniform(10000, 25000), 2)


def compute_fee_tax(amount):
    """Platform fee = 2% of amount, Tax = 18% GST on fee."""
    fee = round(amount * 0.02, 2)
    tax = round(fee * 0.18, 2)
    net_amount = round(amount - fee - tax, 2)
    return fee, tax, net_amount


def settlement_date_for(txn_date):
    """Bank settles 1-2 business days after transaction."""
    days = random.choice([1, 2])
    settle = txn_date + timedelta(days=days)
    # Skip weekends
    while settle.weekday() >= 5:
        settle += timedelta(days=1)
    return settle.date()


def generate_txn_id(index, date):
    """Generate a realistic transaction ID."""
    return f"TXN_{date.strftime('%Y%m%d')}_{str(index).zfill(4)}"


def generate_order_id():
    """Generate a realistic order ID."""
    return f"ORD_{random.randint(10000, 99999)}"


def generate_utr(settle_date):
    """Generate a realistic UTR number."""
    chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    suffix = "".join(random.choices(chars, k=8))
    return f"UTRN{settle_date.strftime('%Y%m%d')}{suffix}"


def generate_bank_ref(settle_date):
    """Generate a realistic bank reference."""
    bank = random.choice(BANK_PREFIXES)
    seq = random.randint(1000, 9999)
    return f"{bank}/{settle_date.strftime('%Y/%m%d')}/{seq}"


def generate_settlement_id(index, settle_date):
    """Generate a realistic settlement ID."""
    return f"STL_{settle_date.strftime('%Y%m%d')}_{str(index).zfill(3)}"


def generate_email(index):
    """Generate a fake customer email."""
    domains = ["gmail.com", "outlook.com", "yahoo.com", "company.in"]
    names = ["rahul", "priya", "amit", "neha", "vikram", "shreya", "arjun", "pooja", "suresh", "divya"]
    name = random.choice(names)
    return f"{name}{random.randint(1, 999)}@{random.choice(domains)}"


# ── Main Generation ────────────────────────────────────────────────────

def generate():
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    transactions = []
    settlements = []
    txn_counter = 0
    stl_counter = 0

    # ── 1. Generate Normal Transactions ─────────────────────────────
    for i in range(NUM_NORMAL_TRANSACTIONS):
        txn_counter += 1
        txn_date = random_datetime_in_march()
        amount = random_amount()
        fee, tax, net_amount = compute_fee_tax(amount)
        txn_id = generate_txn_id(txn_counter, txn_date)

        txn = {
            "transaction_id": txn_id,
            "order_id": generate_order_id(),
            "transaction_date": txn_date.strftime("%Y-%m-%d %H:%M:%S"),
            "amount": f"{amount:.2f}",
            "currency": "INR",
            "payment_method": random.choices(PAYMENT_METHODS, weights=PAYMENT_METHOD_WEIGHTS, k=1)[0],
            "status": "SUCCESS",
            "customer_email": generate_email(txn_counter),
            "merchant_id": random.choice(MERCHANT_IDS),
            "fee": f"{fee:.2f}",
            "tax": f"{tax:.2f}",
            "net_amount": f"{net_amount:.2f}",
        }
        transactions.append(txn)

        # Corresponding settlement
        stl_counter += 1
        settle_date = settlement_date_for(txn_date)
        stl = {
            "settlement_id": generate_settlement_id(stl_counter, settle_date),
            "transaction_id": txn_id,
            "utr": generate_utr(settle_date),
            "settlement_date": str(settle_date),
            "settlement_amount": f"{net_amount:.2f}",
            "bank_reference": generate_bank_ref(settle_date),
            "status": "SETTLED",
        }
        settlements.append(stl)

    # ── 2. Plant Gap Type 1: Cross-Month Settlements ────────────────
    # 3 transactions on March 30-31 that settle in April
    cross_month_txn_ids = []
    for i, day in enumerate([30, 30, 31]):
        txn_counter += 1
        hour = random.randint(14, 21)
        txn_date = datetime(2025, 3, day, hour, random.randint(0, 59), random.randint(0, 59))
        amount = random_amount()
        fee, tax, net_amount = compute_fee_tax(amount)
        txn_id = generate_txn_id(txn_counter, txn_date)
        cross_month_txn_ids.append(txn_id)

        txn = {
            "transaction_id": txn_id,
            "order_id": generate_order_id(),
            "transaction_date": txn_date.strftime("%Y-%m-%d %H:%M:%S"),
            "amount": f"{amount:.2f}",
            "currency": "INR",
            "payment_method": random.choices(PAYMENT_METHODS, weights=PAYMENT_METHOD_WEIGHTS, k=1)[0],
            "status": "SUCCESS",
            "customer_email": generate_email(txn_counter),
            "merchant_id": random.choice(MERCHANT_IDS),
            "fee": f"{fee:.2f}",
            "tax": f"{tax:.2f}",
            "net_amount": f"{net_amount:.2f}",
        }
        transactions.append(txn)

        # Settlement in APRIL (cross-month)
        stl_counter += 1
        settle_date_april = datetime(2025, 4, 1 + i).date()
        stl = {
            "settlement_id": generate_settlement_id(stl_counter, settle_date_april),
            "transaction_id": txn_id,
            "utr": generate_utr(settle_date_april),
            "settlement_date": str(settle_date_april),
            "settlement_amount": f"{net_amount:.2f}",
            "bank_reference": generate_bank_ref(settle_date_april),
            "status": "SETTLED",
        }
        settlements.append(stl)

    # ── 3. Plant Gap Type 2: Rounding Differences ──────────────────
    # 5 transactions with amounts designed to cause fee/tax rounding issues
    # Bank uses a slightly different rounding method at batch level
    rounding_amounts = [333.33, 777.77, 1111.11, 2999.99, 4567.89]
    rounding_txn_ids = []
    for amount in rounding_amounts:
        txn_counter += 1
        txn_date = random_datetime_in_march()
        fee, tax, net_amount = compute_fee_tax(amount)
        txn_id = generate_txn_id(txn_counter, txn_date)
        rounding_txn_ids.append(txn_id)

        txn = {
            "transaction_id": txn_id,
            "order_id": generate_order_id(),
            "transaction_date": txn_date.strftime("%Y-%m-%d %H:%M:%S"),
            "amount": f"{amount:.2f}",
            "currency": "INR",
            "payment_method": random.choices(PAYMENT_METHODS, weights=PAYMENT_METHOD_WEIGHTS, k=1)[0],
            "status": "SUCCESS",
            "customer_email": generate_email(txn_counter),
            "merchant_id": random.choice(MERCHANT_IDS),
            "fee": f"{fee:.2f}",
            "tax": f"{tax:.2f}",
            "net_amount": f"{net_amount:.2f}",
        }
        transactions.append(txn)

        # Settlement with slightly different amount (bank rounds differently)
        stl_counter += 1
        settle_date = settlement_date_for(txn_date)
        # Simulate bank's rounding: recalculate with different intermediate rounding
        bank_fee = amount * 0.02
        bank_tax = bank_fee * 0.18
        bank_net = round(amount - bank_fee - bank_tax, 2)  # rounds final, not intermediates
        # Ensure there IS a difference
        if bank_net == net_amount:
            bank_net = round(bank_net + random.choice([-0.01, 0.01, -0.02, 0.02]), 2)

        stl = {
            "settlement_id": generate_settlement_id(stl_counter, settle_date),
            "transaction_id": txn_id,
            "utr": generate_utr(settle_date),
            "settlement_date": str(settle_date),
            "settlement_amount": f"{bank_net:.2f}",
            "bank_reference": generate_bank_ref(settle_date),
            "status": "SETTLED",
        }
        settlements.append(stl)

    # ── 4. Plant Gap Type 3: Duplicate Entries in Transactions ──────
    # Pick 2 existing normal transactions and duplicate them
    duplicate_indices = [10, 50]
    duplicate_txn_ids = []
    for idx in duplicate_indices:
        dup = transactions[idx].copy()
        duplicate_txn_ids.append(dup["transaction_id"])
        transactions.append(dup)

    # ── 5. Plant Gap Type 4: Orphan Refunds ─────────────────────────
    # 2 refund entries in bank settlements that reference non-existent transactions
    orphan_refund_ids = []
    for i in range(2):
        stl_counter += 1
        fake_txn_id = f"TXN_20250315_9{str(i+1).zfill(3)}"  # non-existent
        orphan_refund_ids.append(fake_txn_id)
        settle_date = datetime(2025, 3, 18 + i).date()
        refund_amount = -round(random.uniform(200, 3000), 2)

        stl = {
            "settlement_id": generate_settlement_id(stl_counter, settle_date),
            "transaction_id": fake_txn_id,
            "utr": generate_utr(settle_date),
            "settlement_date": str(settle_date),
            "settlement_amount": f"{refund_amount:.2f}",
            "bank_reference": generate_bank_ref(settle_date),
            "status": "SETTLED",
        }
        settlements.append(stl)

    # ── Sort and Write CSVs ─────────────────────────────────────────

    # Sort transactions by date
    transactions.sort(key=lambda x: x["transaction_date"])
    settlements.sort(key=lambda x: x["settlement_date"])

    txn_path = OUTPUT_DIR / "transactions.csv"
    stl_path = OUTPUT_DIR / "bank_settlements.csv"

    txn_fields = [
        "transaction_id", "order_id", "transaction_date", "amount", "currency",
        "payment_method", "status", "customer_email", "merchant_id", "fee", "tax", "net_amount"
    ]
    stl_fields = [
        "settlement_id", "transaction_id", "utr", "settlement_date",
        "settlement_amount", "bank_reference", "status"
    ]

    with open(txn_path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=txn_fields)
        writer.writeheader()
        writer.writerows(transactions)

    with open(stl_path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=stl_fields)
        writer.writeheader()
        writer.writerows(settlements)

    # ── Print Summary ───────────────────────────────────────────────
    print("=" * 60)
    print("  DATA GENERATION COMPLETE")
    print("=" * 60)
    print(f"  Transactions CSV : {txn_path}")
    print(f"    Total rows     : {len(transactions)}")
    print(f"    Normal         : {NUM_NORMAL_TRANSACTIONS}")
    print(f"    Cross-month    : 3  (IDs: {cross_month_txn_ids})")
    print(f"    Rounding       : 5  (IDs: {rounding_txn_ids})")
    print(f"    Duplicates     : 2  (IDs: {duplicate_txn_ids})")
    print()
    print(f"  Settlements CSV  : {stl_path}")
    print(f"    Total rows     : {len(settlements)}")
    print(f"    Orphan refunds : 2  (Fake IDs: {orphan_refund_ids})")
    print("=" * 60)


if __name__ == "__main__":
    generate()
