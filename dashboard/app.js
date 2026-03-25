/**
 * Payment Reconciliation Dashboard — Client-Side Engine
 *
 * Parses uploaded CSVs, performs reconciliation entirely in the browser,
 * and renders results with summary cards, tabbed discrepancy views,
 * and a searchable/sortable transaction table.
 */

// ── Sample Data (embedded for static deployment) ─────────────────────
let SAMPLE_TXN_URL = '../data/transactions.csv';
let SAMPLE_STL_URL = '../data/bank_settlements.csv';

// ── State ────────────────────────────────────────────────────────────
let txnData = null;
let stlData = null;
let reconciliationReport = null;
let currentSort = { column: null, ascending: true };

// ── DOM Elements ─────────────────────────────────────────────────────
const txnUploadZone = document.getElementById('txn-upload-zone');
const stlUploadZone = document.getElementById('stl-upload-zone');
const txnFileInput = document.getElementById('txn-file');
const stlFileInput = document.getElementById('stl-file');
const txnStatus = document.getElementById('txn-status');
const stlStatus = document.getElementById('stl-status');
const btnSample = document.getElementById('btn-sample');
const btnReconcile = document.getElementById('btn-reconcile');
const resultsSection = document.getElementById('results-section');
const searchInput = document.getElementById('search-input');

// ── File Upload Handlers ─────────────────────────────────────────────

function setupUploadZone(zone, fileInput, statusEl, onLoad) {
    zone.addEventListener('click', () => fileInput.click());

    zone.addEventListener('dragover', (e) => {
        e.preventDefault();
        zone.style.borderColor = 'var(--accent-indigo)';
    });

    zone.addEventListener('dragleave', () => {
        zone.style.borderColor = '';
    });

    zone.addEventListener('drop', (e) => {
        e.preventDefault();
        zone.style.borderColor = '';
        const file = e.dataTransfer.files[0];
        if (file && file.name.endsWith('.csv')) {
            parseCSVFile(file, statusEl, zone, onLoad);
        }
    });

    fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            parseCSVFile(file, statusEl, zone, onLoad);
        }
    });
}

function parseCSVFile(file, statusEl, zone, onLoad) {
    Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        complete: (results) => {
            statusEl.textContent = `✓ ${results.data.length} rows loaded`;
            zone.classList.add('loaded');
            onLoad(results.data);
            checkReady();
        },
        error: (err) => {
            statusEl.textContent = `✗ Error: ${err.message}`;
        }
    });
}

function checkReady() {
    btnReconcile.disabled = !(txnData && stlData);
}

setupUploadZone(txnUploadZone, txnFileInput, txnStatus, (data) => { txnData = data; });
setupUploadZone(stlUploadZone, stlFileInput, stlStatus, (data) => { stlData = data; });

// ── Sample Data ──────────────────────────────────────────────────────
btnSample.addEventListener('click', async () => {
    btnSample.disabled = true;
    btnSample.innerHTML = '<span class="spinner"></span> Loading...';

    try {
        const [txnRes, stlRes] = await Promise.all([
            fetch(SAMPLE_TXN_URL).then(r => r.text()),
            fetch(SAMPLE_STL_URL).then(r => r.text())
        ]);

        const txnParsed = Papa.parse(txnRes, { header: true, skipEmptyLines: true });
        const stlParsed = Papa.parse(stlRes, { header: true, skipEmptyLines: true });

        txnData = txnParsed.data;
        stlData = stlParsed.data;

        txnStatus.textContent = `✓ ${txnData.length} rows loaded (sample)`;
        stlStatus.textContent = `✓ ${stlData.length} rows loaded (sample)`;
        txnUploadZone.classList.add('loaded');
        stlUploadZone.classList.add('loaded');

        checkReady();
    } catch (err) {
        txnStatus.textContent = `✗ Failed to load sample data`;
        console.error(err);
    }

    btnSample.disabled = false;
    btnSample.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
        </svg>
        Use Sample Data`;
});

// ── Reconciliation Engine (Client-Side) ──────────────────────────────

function reconcile(transactions, settlements) {
    // 1. Find duplicates
    const txnIdCount = {};
    transactions.forEach(t => {
        txnIdCount[t.transaction_id] = (txnIdCount[t.transaction_id] || 0) + 1;
    });

    const stlIdCount = {};
    settlements.forEach(s => {
        stlIdCount[s.transaction_id] = (stlIdCount[s.transaction_id] || 0) + 1;
    });

    const duplicates = [];
    for (const [tid, count] of Object.entries(txnIdCount)) {
        if (count > 1) {
            const rows = transactions.filter(t => t.transaction_id === tid);
            duplicates.push({
                transaction_id: tid,
                occurrences: count,
                dataset: 'transactions',
                rows: rows,
                order_id: rows[0].order_id || '',
                amount: parseFloat(rows[0].amount) || 0,
                payment_method: rows[0].payment_method || '',
            });
        }
    }
    for (const [tid, count] of Object.entries(stlIdCount)) {
        if (count > 1) {
            const rows = settlements.filter(s => s.transaction_id === tid);
            duplicates.push({
                transaction_id: tid,
                occurrences: count,
                dataset: 'bank_settlements',
                rows: rows,
                order_id: '',
                amount: parseFloat(rows[0].settlement_amount) || 0,
                payment_method: '',
            });
        }
    }

    // 2. Build lookup maps (first occurrence)
    const txnMap = {};
    transactions.forEach(t => {
        if (!txnMap[t.transaction_id]) txnMap[t.transaction_id] = t;
    });

    const stlMap = {};
    settlements.forEach(s => {
        if (!stlMap[s.transaction_id]) stlMap[s.transaction_id] = s;
    });

    const txnIds = new Set(Object.keys(txnMap));
    const stlIds = new Set(Object.keys(stlMap));

    // 3. Orphan refunds (in settlements, not in transactions)
    const orphanRefunds = [];
    stlIds.forEach(tid => {
        if (!txnIds.has(tid)) {
            const s = stlMap[tid];
            orphanRefunds.push({
                settlement_id: s.settlement_id,
                transaction_id: tid,
                settlement_amount: parseFloat(s.settlement_amount),
                settlement_date: s.settlement_date,
                utr: s.utr,
                bank_reference: s.bank_reference,
            });
        }
    });

    // 4. Missing settlements
    const missingSettlements = [];
    txnIds.forEach(tid => {
        if (!stlIds.has(tid)) {
            const t = txnMap[tid];
            missingSettlements.push({
                transaction_id: tid,
                transaction_date: t.transaction_date,
                amount: parseFloat(t.amount),
                net_amount: parseFloat(t.net_amount),
                status: t.status,
            });
        }
    });

    // 5. Match and compare
    const matched = [];
    const crossMonth = [];
    const amountMismatches = [];

    txnIds.forEach(tid => {
        if (!stlIds.has(tid)) return;

        const t = txnMap[tid];
        const s = stlMap[tid];

        const txnNet = parseFloat(t.net_amount);
        const stlAmt = parseFloat(s.settlement_amount);

        const txnDate = new Date(t.transaction_date);
        const stlDate = new Date(s.settlement_date);

        const isCrossMonth = txnDate.getMonth() !== stlDate.getMonth() ||
                             txnDate.getFullYear() !== stlDate.getFullYear();
        const diff = Math.round(Math.abs(txnNet - stlAmt) * 100) / 100;
        const hasMismatch = diff > 0.001;

        const record = {
            transaction_id: tid,
            transaction_date: t.transaction_date,
            settlement_date: s.settlement_date,
            expected_amount: txnNet,
            actual_amount: stlAmt,
            difference: diff,
            payment_method: t.payment_method,
            merchant_id: t.merchant_id,
            order_id: t.order_id,
            utr: s.utr,
        };

        if (isCrossMonth) {
            crossMonth.push(record);
        } else if (hasMismatch) {
            amountMismatches.push(record);
        } else {
            matched.push(record);
        }
    });

    return {
        summary: {
            total_transactions: transactions.length,
            total_settlements: settlements.length,
            matched: matched.length,
            cross_month: crossMonth.length,
            amount_mismatches: amountMismatches.length,
            duplicates_in_transactions: duplicates.filter(d => d.dataset === 'transactions').length,
            duplicates_in_settlements: duplicates.filter(d => d.dataset === 'bank_settlements').length,
            missing_settlements: missingSettlements.length,
            orphan_refunds: orphanRefunds.length,
        },
        discrepancies: {
            cross_month: crossMonth,
            amount_mismatches: amountMismatches,
            duplicates: duplicates,
            orphan_refunds: orphanRefunds,
            missing_settlements: missingSettlements,
        },
        matched: matched,
    };
}

// ── Run Reconciliation ──────────────────────────────────────────────

btnReconcile.addEventListener('click', () => {
    if (!txnData || !stlData) return;

    btnReconcile.disabled = true;
    btnReconcile.innerHTML = '<span class="spinner"></span> Reconciling...';

    // Allow UI to update before heavy computation
    setTimeout(() => {
        reconciliationReport = reconcile(txnData, stlData);
        renderResults(reconciliationReport);

        btnReconcile.disabled = false;
        btnReconcile.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
            </svg>
            Run Reconciliation`;

        resultsSection.classList.remove('hidden');
        resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
});

// ── Render Results ──────────────────────────────────────────────────

function renderResults(report) {
    // Summary cards
    animateCount('card-matched', report.summary.matched);
    animateCount('card-cross-month', report.summary.cross_month);
    animateCount('card-mismatch', report.summary.amount_mismatches);
    animateCount('card-duplicates', report.summary.duplicates_in_transactions + report.summary.duplicates_in_settlements);
    animateCount('card-orphans', report.summary.orphan_refunds);

    // Build all_transactions list for the main table
    const allTxns = [];

    report.matched.forEach(r => allTxns.push({ ...r, status: 'MATCHED' }));
    report.discrepancies.cross_month.forEach(r => allTxns.push({ ...r, status: 'CROSS_MONTH' }));
    report.discrepancies.amount_mismatches.forEach(r => allTxns.push({ ...r, status: 'AMOUNT_MISMATCH' }));
    report.discrepancies.missing_settlements.forEach(r => {
        allTxns.push({
            ...r,
            status: 'MISSING_SETTLEMENT',
            expected_amount: r.net_amount,
            actual_amount: 0,
            difference: r.net_amount,
            settlement_date: '—',
            payment_method: '',
            merchant_id: '',
        });
    });
    report.discrepancies.orphan_refunds.forEach(r => {
        allTxns.push({
            ...r,
            status: 'ORPHAN_REFUND',
            transaction_date: '—',
            expected_amount: 0,
            actual_amount: r.settlement_amount,
            difference: Math.abs(r.settlement_amount),
            payment_method: '',
            merchant_id: '',
        });
    });

    allTxns.sort((a, b) => (a.transaction_date || '').localeCompare(b.transaction_date || ''));

    renderAllTable(allTxns);
    renderCrossMonthTable(report.discrepancies.cross_month);
    renderMismatchTable(report.discrepancies.amount_mismatches);
    renderDuplicatesTable(report.discrepancies.duplicates);
    renderOrphansTable(report.discrepancies.orphan_refunds);

    // Store for search
    window._allTxns = allTxns;
}

// ── Count Animation ─────────────────────────────────────────────────

function animateCount(elementId, target) {
    const el = document.getElementById(elementId);
    el.classList.add('animate');
    const duration = 600;
    const start = performance.now();

    function step(timestamp) {
        const progress = Math.min((timestamp - start) / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3); // easeOutCubic
        el.textContent = Math.round(eased * target);
        if (progress < 1) requestAnimationFrame(step);
    }

    requestAnimationFrame(step);
}

// ── Table Renderers ─────────────────────────────────────────────────

function statusPillHTML(status) {
    const labels = {
        'MATCHED': 'Matched',
        'CROSS_MONTH': 'Cross-Month',
        'AMOUNT_MISMATCH': 'Mismatch',
        'MISSING_SETTLEMENT': 'Missing',
        'ORPHAN_REFUND': 'Orphan',
    };
    const classes = {
        'MATCHED': 'matched',
        'CROSS_MONTH': 'cross-month',
        'AMOUNT_MISMATCH': 'mismatch',
        'MISSING_SETTLEMENT': 'mismatch',
        'ORPHAN_REFUND': 'orphan',
    };
    return `<span class="status-pill ${classes[status] || ''}">${labels[status] || status}</span>`;
}

function formatAmount(val) {
    if (val === undefined || val === null || val === '' || isNaN(val)) return '—';
    return parseFloat(val).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function diffHTML(val) {
    if (!val || val === 0) return '<span class="diff-zero">0.00</span>';
    return `<span class="diff-positive">₹${formatAmount(val)}</span>`;
}

function renderAllTable(rows) {
    const tbody = document.querySelector('#table-all tbody');
    tbody.innerHTML = rows.map(r => `
        <tr>
            <td>${statusPillHTML(r.status)}</td>
            <td>${r.transaction_id || '—'}</td>
            <td>${r.transaction_date || '—'}</td>
            <td>${r.settlement_date || '—'}</td>
            <td>₹${formatAmount(r.expected_amount)}</td>
            <td>₹${formatAmount(r.actual_amount)}</td>
            <td>${diffHTML(r.difference)}</td>
            <td>${r.payment_method || '—'}</td>
            <td>${r.merchant_id || '—'}</td>
        </tr>
    `).join('');
}

function renderCrossMonthTable(rows) {
    const tbody = document.querySelector('#table-cross-month tbody');
    tbody.innerHTML = rows.map(r => `
        <tr>
            <td>${r.transaction_id}</td>
            <td>${r.transaction_date}</td>
            <td>${r.settlement_date}</td>
            <td>₹${formatAmount(r.expected_amount)}</td>
            <td>₹${formatAmount(r.actual_amount)}</td>
            <td>${diffHTML(r.difference)}</td>
            <td>${r.payment_method}</td>
            <td>${r.utr}</td>
        </tr>
    `).join('');
}

function renderMismatchTable(rows) {
    const tbody = document.querySelector('#table-mismatch tbody');
    tbody.innerHTML = rows.map(r => `
        <tr>
            <td>${r.transaction_id}</td>
            <td>₹${formatAmount(r.expected_amount)}</td>
            <td>₹${formatAmount(r.actual_amount)}</td>
            <td>${diffHTML(r.difference)}</td>
            <td>${r.transaction_date}</td>
            <td>${r.payment_method}</td>
            <td>${r.merchant_id}</td>
        </tr>
    `).join('');
}

function renderDuplicatesTable(rows) {
    const tbody = document.querySelector('#table-duplicates tbody');
    tbody.innerHTML = rows.map(r => `
        <tr>
            <td>${r.transaction_id}</td>
            <td>${r.occurrences}</td>
            <td>${r.dataset}</td>
            <td>${r.order_id || '—'}</td>
            <td>₹${formatAmount(r.amount)}</td>
            <td>${r.payment_method || '—'}</td>
        </tr>
    `).join('');
}

function renderOrphansTable(rows) {
    const tbody = document.querySelector('#table-orphans tbody');
    tbody.innerHTML = rows.map(r => `
        <tr>
            <td>${r.settlement_id}</td>
            <td>${r.transaction_id}</td>
            <td>₹${formatAmount(r.settlement_amount)}</td>
            <td>${r.settlement_date}</td>
            <td>${r.utr}</td>
            <td>${r.bank_reference}</td>
        </tr>
    `).join('');
}

// ── Tab Switching ───────────────────────────────────────────────────

document.getElementById('tab-bar').addEventListener('click', (e) => {
    if (!e.target.classList.contains('tab')) return;

    const tabId = e.target.dataset.tab;

    // Update active tab
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    e.target.classList.add('active');

    // Update active panel
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    document.getElementById(`panel-${tabId}`).classList.add('active');
});

// ── Search ──────────────────────────────────────────────────────────

searchInput.addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase().trim();
    if (!window._allTxns) return;

    const filtered = query
        ? window._allTxns.filter(r =>
            (r.transaction_id || '').toLowerCase().includes(query) ||
            (r.order_id || '').toLowerCase().includes(query) ||
            (r.merchant_id || '').toLowerCase().includes(query) ||
            (r.payment_method || '').toLowerCase().includes(query)
        )
        : window._allTxns;

    renderAllTable(filtered);
});

// ── Column Sorting ──────────────────────────────────────────────────

document.querySelector('#table-all thead').addEventListener('click', (e) => {
    const th = e.target.closest('th');
    if (!th || !th.dataset.sort) return;

    const column = th.dataset.sort;
    if (currentSort.column === column) {
        currentSort.ascending = !currentSort.ascending;
    } else {
        currentSort.column = column;
        currentSort.ascending = true;
    }

    if (!window._allTxns) return;

    const sorted = [...window._allTxns].sort((a, b) => {
        let aVal = a[column] || '';
        let bVal = b[column] || '';

        // Try numeric comparison
        const aNum = parseFloat(aVal);
        const bNum = parseFloat(bVal);
        if (!isNaN(aNum) && !isNaN(bNum)) {
            return currentSort.ascending ? aNum - bNum : bNum - aNum;
        }

        // String comparison
        return currentSort.ascending
            ? String(aVal).localeCompare(String(bVal))
            : String(bVal).localeCompare(String(aVal));
    });

    renderAllTable(sorted);
});
