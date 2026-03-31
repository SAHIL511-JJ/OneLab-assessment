
/**
 * Payment Reconciliation Dashboard - upload-safe client-side engine.
 */

const SAMPLE_TXN_URL = './data/transactions.csv';
const SAMPLE_STL_URL = './data/bank_settlements.csv';
const DEFAULT_ROW_MISMATCH_TOLERANCE = 0.02;
const MIN_ROW_MISMATCH_TOLERANCE = 0;
const MAX_ROW_MISMATCH_TOLERANCE = 10;
const RESULTS_STORAGE_KEY = 'reconciliation_results_v1';

const REQUIRED_FIELDS = {
    txn: [
        { key: 'transaction_id', label: 'Transaction ID', aliases: ['transactionid', 'txnid', 'paymentid', 'referenceid', 'merchantreferenceid'] },
        { key: 'transaction_date', label: 'Transaction Date', aliases: ['transactiondate', 'txndate', 'paidat', 'createdat', 'timestamp', 'date'] },
        { key: 'expected_amount', label: 'Expected Amount / Net Amount', aliases: ['netamount', 'expectedamount', 'receivableamount', 'payableamount', 'transactionamount', 'amount', 'paidamount'] },
    ],
    stl: [
        { key: 'transaction_id', label: 'Transaction ID', aliases: ['transactionid', 'txnid', 'paymentid', 'referenceid', 'merchantreferenceid'] },
        { key: 'settlement_date', label: 'Settlement Date', aliases: ['settlementdate', 'settleddate', 'valuedate', 'posteddate', 'creditdate', 'date'] },
        { key: 'settlement_amount', label: 'Settlement Amount', aliases: ['settlementamount', 'settledamount', 'creditamount', 'amount', 'netamount'] },
    ],
};

const OPTIONAL_FIELDS = {
    txn: [
        { key: 'order_id', aliases: ['orderid', 'merchantorderid', 'orderreference'] },
        { key: 'payment_method', aliases: ['paymentmethod', 'method', 'instrument', 'channel'] },
        { key: 'merchant_id', aliases: ['merchantid', 'merchant', 'mid'] },
        { key: 'status', aliases: ['status', 'transactionstatus'] },
    ],
    stl: [
        { key: 'settlement_id', aliases: ['settlementid', 'batchid', 'payoutid', 'batchreference'] },
        { key: 'utr', aliases: ['utr', 'utrnumber', 'bankutr', 'rrn', 'referencenumber'] },
        { key: 'bank_reference', aliases: ['bankreference', 'bankref', 'banknarration', 'remarks'] },
        { key: 'status', aliases: ['status', 'settlementstatus'] },
    ],
};

let rawTxnData = null;
let rawStlData = null;
let txnData = null;
let stlData = null;
let reconciliationReport = null;
let inputMode = null;
let mappingApplied = false;
let currentSort = { column: null, ascending: true };
let currentMapping = { txn: {}, stl: {} };
let rowMismatchTolerance = DEFAULT_ROW_MISMATCH_TOLERANCE;

const dom = {
    txnUploadZone: document.getElementById('txn-upload-zone'),
    stlUploadZone: document.getElementById('stl-upload-zone'),
    txnFileInput: document.getElementById('txn-file'),
    stlFileInput: document.getElementById('stl-file'),
    txnStatus: document.getElementById('txn-status'),
    stlStatus: document.getElementById('stl-status'),
    btnSample: document.getElementById('btn-sample'),
    btnReconcile: document.getElementById('btn-reconcile'),
    btnApplyMapping: document.getElementById('btn-apply-mapping'),
    resultsSection: document.getElementById('results-section'),
    searchInput: document.getElementById('search-input'),
    mappingPanel: document.getElementById('mapping-panel'),
    mappingBadge: document.getElementById('mapping-badge'),
    mappingMessage: document.getElementById('mapping-message'),
    validationPanel: document.getElementById('validation-panel'),
    validationList: document.getElementById('validation-list'),
    txnFileName: document.getElementById('txn-file-name'),
    stlFileName: document.getElementById('stl-file-name'),
    aggregateRoundingNote: document.getElementById('aggregate-rounding-note'),
    rowToleranceInput: document.getElementById('row-tolerance-input'),
    rowToleranceHelp: document.getElementById('row-tolerance-help'),
};

function normalizeHeaderName(value) {
    return String(value || '').toLowerCase().trim().replaceAll(/[^a-z0-9]/g, '');
}

function normalizeCell(value) {
    return value == null ? '' : String(value).trim();
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll(/&/g, '&amp;')
        .replaceAll(/</g, '&lt;')
        .replaceAll(/>/g, '&gt;')
        .replaceAll(/\"/g, '&quot;')
        .replaceAll(/'/g, '&#39;');
}

function zeroPad(value) {
    return String(value).padStart(2, '0');
}

function isEntireRowBlank(row) {
    return Object.entries(row || {}).every(([key, value]) => key === '__parsed_extra' || normalizeCell(value) === '');
}

function dedupeMessages(messages) {
    return [...new Set(messages.filter(Boolean))];
}

function setUploadStatus(kind, message, isError = false) {
    const statusEl = kind === 'txn' ? dom.txnStatus : dom.stlStatus;
    statusEl.textContent = message;
    statusEl.classList.toggle('error', isError);
}

function setUploadLoaded(kind, loaded) {
    const zone = kind === 'txn' ? dom.txnUploadZone : dom.stlUploadZone;
    zone.classList.toggle('loaded', loaded);
}

function resetResults() {
    reconciliationReport = null;
    dom.resultsSection.classList.add('hidden');
    dom.searchInput.value = '';
    dom.aggregateRoundingNote.classList.add('hidden');
    dom.aggregateRoundingNote.textContent = '';
    sessionStorage.removeItem(RESULTS_STORAGE_KEY);
    window._allTxns = null;
}

function persistResultsState() {
    if (!reconciliationReport) {
        sessionStorage.removeItem(RESULTS_STORAGE_KEY);
        return;
    }

    sessionStorage.setItem(
        RESULTS_STORAGE_KEY,
        JSON.stringify({
            report: reconciliationReport,
            saved_at: Date.now(),
        })
    );
}

function restoreResultsState() {
    const raw = sessionStorage.getItem(RESULTS_STORAGE_KEY);
    if (!raw) {
        return;
    }

    try {
        const parsed = JSON.parse(raw);
        if (!parsed || !parsed.report) {
            return;
        }
        reconciliationReport = parsed.report;
        renderResults(reconciliationReport);
        dom.resultsSection.classList.remove('hidden');
    } catch (error) {
        sessionStorage.removeItem(RESULTS_STORAGE_KEY);
    }
}

function clampTolerance(value) {
    return Math.min(MAX_ROW_MISMATCH_TOLERANCE, Math.max(MIN_ROW_MISMATCH_TOLERANCE, value));
}

function updateToleranceHelpMessage() {
    dom.rowToleranceHelp.textContent = `Differences up to ₹${rowMismatchTolerance.toFixed(2)} are treated as rounding tolerance and excluded from mismatch and variance totals.`;
}

function applyToleranceSettingFromInput() {
    const rawValue = normalizeCell(dom.rowToleranceInput.value);
    if (!rawValue) {
        rowMismatchTolerance = DEFAULT_ROW_MISMATCH_TOLERANCE;
        dom.rowToleranceInput.value = rowMismatchTolerance.toFixed(2);
        updateToleranceHelpMessage();
        return;
    }

    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed)) {
        dom.rowToleranceInput.value = rowMismatchTolerance.toFixed(2);
        return;
    }

    rowMismatchTolerance = clampTolerance(Math.round(parsed * 100) / 100);
    dom.rowToleranceInput.value = rowMismatchTolerance.toFixed(2);
    updateToleranceHelpMessage();
}

function setMappingBadge(label, tone) {
    dom.mappingBadge.textContent = label;
    dom.mappingBadge.classList.remove('is-pending', 'is-ready', 'is-error');
    if (tone) {
        dom.mappingBadge.classList.add(`is-${tone}`);
    }
}

function renderMessage(element, baseClass, type, lines) {
    if (!lines || !lines.length) {
        element.className = `${baseClass} hidden`;
        element.innerHTML = '';
        return;
    }

    const items = lines.map((line) => `<li>${escapeHtml(line)}</li>`).join('');
    element.className = `${baseClass} ${type}`;
    element.innerHTML = lines.length === 1 ? `<p>${escapeHtml(lines[0])}</p>` : `<ul>${items}</ul>`;
}

function renderValidationPanel(type, lines) {
    if (!lines || !lines.length) {
        dom.validationPanel.className = 'validation-panel hidden';
        dom.validationList.innerHTML = '';
        return;
    }

    dom.validationPanel.className = `validation-panel ${type}`;
    dom.validationList.innerHTML = lines.map((line) => `<li>${escapeHtml(line)}</li>`).join('');
}

function getFieldConfig(dataset, key) {
    return REQUIRED_FIELDS[dataset].find((field) => field.key === key);
}

function getSelectElement(dataset, key) {
    return document.getElementById(`map-${dataset}-${key.replaceAll(/_/g, '-')}`);
}

function updateReadyState() {
    const uploadsLoaded = inputMode === 'upload' && rawTxnData && rawStlData;
    dom.btnApplyMapping.disabled = !uploadsLoaded;
    const canRunSample = inputMode === 'sample' && Boolean(txnData && stlData);
    const canRunUpload = inputMode === 'upload' && mappingApplied && Boolean(txnData && stlData);
    dom.btnReconcile.disabled = !(canRunSample || canRunUpload);
}

function scoreHeader(header, aliases) {
    const normalizedHeader = normalizeHeaderName(header);
    let bestScore = 0;

    aliases.forEach((alias, index) => {
        const normalizedAlias = normalizeHeaderName(alias);
        if (!normalizedAlias) {
            return;
        }
        if (normalizedHeader === normalizedAlias) {
            bestScore = Math.max(bestScore, 100 - index);
            return;
        }
        if (normalizedHeader.includes(normalizedAlias) || normalizedAlias.includes(normalizedHeader)) {
            bestScore = Math.max(bestScore, 60 - index);
        }
    });

    return bestScore;
}

function suggestHeader(headers, aliases, usedHeaders = new Set()) {
    const ranked = headers
        .filter((header) => !usedHeaders.has(header))
        .map((header) => ({ header, score: scoreHeader(header, aliases) }))
        .filter((candidate) => candidate.score > 0)
        .sort((left, right) => right.score - left.score || left.header.localeCompare(right.header));

    if (!ranked.length) {
        return { header: '', ambiguous: false, candidates: [] };
    }
    if (ranked[1] && ranked[1].score === ranked[0].score) {
        return {
            header: '',
            ambiguous: true,
            candidates: ranked.filter((candidate) => candidate.score === ranked[0].score).map((candidate) => candidate.header),
        };
    }
    return { header: ranked[0].header, ambiguous: false, candidates: [ranked[0].header] };
}

function collectParserWarnings(results) {
    const warnings = [];
    const seen = new Set();

    (results.errors || []).forEach((error) => {
        const prefix = typeof error.row === 'number' ? `Parser warning at row ${error.row + 2}` : 'Parser warning';
        const message = `${prefix}: ${error.message}`;
        if (!seen.has(message)) {
            warnings.push(message);
            seen.add(message);
        }
    });

    return warnings;
}

function buildPayloadFromResults(fileName, results) {
    return {
        fileName,
        headers: (results.meta.fields || []).map(normalizeCell).filter(Boolean),
        rows: (results.data || []).filter((row) => !isEntireRowBlank(row)),
        warnings: collectParserWarnings(results),
    };
}

function parseCsvText(text, fileName) {
    const results = Papa.parse(text, {
        header: true,
        skipEmptyLines: true,
        transformHeader: (header) => normalizeCell(header),
    });
    return buildPayloadFromResults(fileName, results);
}

function clearMappedData() {
    txnData = null;
    stlData = null;
    mappingApplied = false;
    updateReadyState();
}

function clearDataset(kind) {
    if (kind === 'txn') {
        rawTxnData = null;
        dom.txnFileName.textContent = '';
    } else {
        rawStlData = null;
        dom.stlFileName.textContent = '';
    }
    clearMappedData();
    resetResults();
}

function clearAllUploadState() {
    rawTxnData = null;
    rawStlData = null;
    dom.txnFileName.textContent = '';
    dom.stlFileName.textContent = '';
    setUploadLoaded('txn', false);
    setUploadLoaded('stl', false);
    setUploadStatus('txn', '');
    setUploadStatus('stl', '');
    clearMappedData();
    resetResults();
}

function collectMappingSelections() {
    const mapping = { txn: {}, stl: {} };
    Object.keys(REQUIRED_FIELDS).forEach((dataset) => {
        REQUIRED_FIELDS[dataset].forEach((field) => {
            mapping[dataset][field.key] = getSelectElement(dataset, field.key).value;
        });
    });
    return mapping;
}

function findMappingProblems(mapping) {
    const problems = [];
    Object.keys(REQUIRED_FIELDS).forEach((dataset) => {
        const seen = new Map();
        REQUIRED_FIELDS[dataset].forEach((field) => {
            const selected = mapping[dataset][field.key];
            if (!selected) {
                problems.push(`${dataset === 'txn' ? 'Transactions' : 'Settlements'} CSV: choose a column for ${field.label}.`);
                return;
            }
            if (seen.has(selected)) {
                problems.push(`${dataset === 'txn' ? 'Transactions' : 'Settlements'} CSV: ${field.label} cannot reuse the same column as ${seen.get(selected)}.`);
                return;
            }
            seen.set(selected, field.label);
        });
    });
    return problems;
}

function renderPendingMappingState() {
    const mapping = collectMappingSelections();
    const missing = findMappingProblems(mapping);
    const parserWarnings = dedupeMessages([...(rawTxnData ? rawTxnData.warnings : []), ...(rawStlData ? rawStlData.warnings : [])]);
    const lines = missing.length
        ? missing
        : [
            'Review the suggested columns and click Apply Mapping.',
            'Optional fields such as order ID, merchant, UTR, and bank reference are auto-detected when possible.',
        ];
    if (parserWarnings.length) {
        lines.push('Parser warnings were detected. Review the preflight output after applying the mapping.');
    }
    renderMessage(dom.mappingMessage, 'mapping-message', 'info', lines);
    renderValidationPanel('', []);
    setMappingBadge('Mapping required', 'pending');
}
function populateSelect(selectEl, headers, suggestedValue) {
    selectEl.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Select a column';
    selectEl.appendChild(placeholder);

    headers.forEach((header) => {
        const option = document.createElement('option');
        option.value = header;
        option.textContent = header;
        selectEl.appendChild(option);
    });

    selectEl.value = suggestedValue && headers.includes(suggestedValue) ? suggestedValue : '';
}

function refreshMappingPanel() {
    const readyForMapping = inputMode === 'upload' && rawTxnData && rawStlData;
    dom.mappingPanel.classList.toggle('hidden', !readyForMapping);

    if (!readyForMapping) {
        renderMessage(dom.mappingMessage, 'mapping-message', '', []);
        renderValidationPanel('', []);
        setMappingBadge('Waiting for files', '');
        return;
    }

    dom.txnFileName.textContent = rawTxnData.fileName;
    dom.stlFileName.textContent = rawStlData.fileName;

    Object.keys(REQUIRED_FIELDS).forEach((dataset) => {
        const headers = dataset === 'txn' ? rawTxnData.headers : rawStlData.headers;
        const usedHeaders = new Set();

        REQUIRED_FIELDS[dataset].forEach((field) => {
            const selectEl = getSelectElement(dataset, field.key);
            const currentValue = currentMapping[dataset][field.key];
            let selectedValue = currentValue && headers.includes(currentValue) ? currentValue : '';

            if (!selectedValue) {
                const suggestion = suggestHeader(headers, field.aliases, usedHeaders);
                selectedValue = suggestion.header;
            }
            if (selectedValue) {
                usedHeaders.add(selectedValue);
            }
            populateSelect(selectEl, headers, selectedValue);
        });
    });

    currentMapping = collectMappingSelections();
    renderPendingMappingState();
    updateReadyState();
}

function parseAmountValue(value) {
    const raw = normalizeCell(value);
    if (!raw) {
        return { error: 'is blank' };
    }

    let cleaned = raw
        .replaceAll(/,/g, '')
        .replaceAll(/\s+/g, '')
        .replaceAll(/inr/ig, '')
        .replaceAll(/rs\.?/ig, '')
        .replaceAll(/[\$\u20b9\u00a3\u20ac]/g, '');

    let negative = false;
    if (cleaned.startsWith('(') && cleaned.endsWith(')')) {
        negative = true;
        cleaned = cleaned.slice(1, -1);
    }

    if (!/^[-+]?\d*\.?\d+$/.test(cleaned)) {
        return { error: `"${raw}" is not a valid amount` };
    }

    const numeric = Number(cleaned);
    if (!Number.isFinite(numeric)) {
        return { error: `"${raw}" is not a valid amount` };
    }

    const valueNumber = negative ? -Math.abs(numeric) : numeric;
    return { value: Math.round(valueNumber * 100) / 100 };
}

function normalizeYear(year) {
    return year < 100 ? 2000 + year : year;
}

function isValidDateParts(year, month, day) {
    const probe = new Date(Date.UTC(year, month - 1, day));
    return probe.getUTCFullYear() === year
        && probe.getUTCMonth() === month - 1
        && probe.getUTCDate() === day;
}

function buildCanonicalDate(parts) {
    const year = Number(parts.year);
    const month = Number(parts.month);
    const day = Number(parts.day);
    const hour = Number(parts.hour || 0);
    const minute = Number(parts.minute || 0);
    const second = Number(parts.second || 0);

    if (!isValidDateParts(year, month, day)) {
        return { error: 'is not a valid calendar date' };
    }
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) {
        return { error: 'contains an invalid time value' };
    }

    const datePart = `${year}-${zeroPad(month)}-${zeroPad(day)}`;
    const timePart = `${zeroPad(hour)}:${zeroPad(minute)}:${zeroPad(second)}`;
    return {
        value: parts.includeTime ? `${datePart} ${timePart}` : datePart,
        warning: parts.warning || '',
    };
}

function parseDateValue(value, includeTime) {
    const raw = normalizeCell(value);
    if (!raw) {
        return { error: 'is blank' };
    }

    const cleaned = raw.replaceAll(/\s+/g, ' ').trim();
    let match = cleaned.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
    if (match) {
        return buildCanonicalDate({
            year: match[1],
            month: match[2],
            day: match[3],
            hour: match[4] || 0,
            minute: match[5] || 0,
            second: match[6] || 0,
            includeTime,
        });
    }

    match = cleaned.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
    if (match) {
        const first = Number(match[1]);
        const second = Number(match[2]);
        const year = normalizeYear(Number(match[3]));
        let day = first;
        let month = second;
        let warning = '';

        if (first <= 12 && second > 12) {
            month = first;
            day = second;
            warning = 'interpreted slash date as MM/DD/YYYY';
        } else if (first <= 12 && second <= 12) {
            warning = 'ambiguous slash date interpreted as DD/MM/YYYY';
        }

        return buildCanonicalDate({
            year,
            month,
            day,
            hour: match[4] || 0,
            minute: match[5] || 0,
            second: match[6] || 0,
            includeTime,
            warning,
        });
    }

    const parsed = new Date(cleaned);
    if (!Number.isNaN(parsed.getTime())) {
        return buildCanonicalDate({
            year: parsed.getFullYear(),
            month: parsed.getMonth() + 1,
            day: parsed.getDate(),
            hour: parsed.getHours(),
            minute: parsed.getMinutes(),
            second: parsed.getSeconds(),
            includeTime,
            warning: 'date parsed using browser fallback',
        });
    }

    return { error: `"${raw}" is not a supported date format` };
}

function detectOptionalMappings(headers, dataset, requiredMapping) {
    const usedHeaders = new Set(Object.values(requiredMapping));
    const optionalMappings = {};

    OPTIONAL_FIELDS[dataset].forEach((field) => {
        const suggestion = suggestHeader(headers, field.aliases, usedHeaders);
        if (suggestion.header) {
            optionalMappings[field.key] = suggestion.header;
            usedHeaders.add(suggestion.header);
        }
    });

    return optionalMappings;
}

function getOptionalValue(row, optionalMappings, key, fallback = '') {
    const header = optionalMappings[key];
    return header ? normalizeCell(row[header]) : fallback;
}

function normalizeTransactions(payload, mapping, optionalMappings) {
    const rows = [];
    const errors = [];
    const warnings = [];
    let invalidCount = 0;
    let warningCount = 0;

    payload.rows.forEach((row, index) => {
        if (isEntireRowBlank(row)) {
            return;
        }

        const rowNumber = index + 2;
        const id = normalizeCell(row[mapping.transaction_id]);
        const dateResult = parseDateValue(row[mapping.transaction_date], true);
        const amountResult = parseAmountValue(row[mapping.expected_amount]);
        const issues = [];

        if (!id) {
            issues.push('transaction ID is blank');
        }
        if (dateResult.error) {
            issues.push(`transaction date ${dateResult.error}`);
        }
        if (amountResult.error) {
            issues.push(`expected amount ${amountResult.error}`);
        }

        if (issues.length) {
            invalidCount += 1;
            if (errors.length < 8) {
                errors.push(`Transactions CSV row ${rowNumber}: ${issues.join(', ')}.`);
            }
            return;
        }

        if (dateResult.warning) {
            warningCount += 1;
            if (warnings.length < 6) {
                warnings.push(`Transactions CSV row ${rowNumber}: ${dateResult.warning}.`);
            }
        }

        rows.push({
            transaction_id: id,
            transaction_date: dateResult.value,
            net_amount: amountResult.value,
            amount: amountResult.value,
            order_id: getOptionalValue(row, optionalMappings, 'order_id'),
            payment_method: getOptionalValue(row, optionalMappings, 'payment_method'),
            merchant_id: getOptionalValue(row, optionalMappings, 'merchant_id'),
            status: getOptionalValue(row, optionalMappings, 'status', 'SUCCESS') || 'SUCCESS',
        });
    });

    if (invalidCount > errors.length) {
        errors.push(`Transactions CSV has ${invalidCount - errors.length} more invalid row(s).`);
    }
    if (warningCount > warnings.length) {
        warnings.push(`Transactions CSV has ${warningCount - warnings.length} more date parsing warning(s).`);
    }

    return { rows, errors, warnings };
}
function normalizeSettlements(payload, mapping, optionalMappings) {
    const rows = [];
    const errors = [];
    const warnings = [];
    let invalidCount = 0;
    let warningCount = 0;

    payload.rows.forEach((row, index) => {
        if (isEntireRowBlank(row)) {
            return;
        }

        const rowNumber = index + 2;
        const id = normalizeCell(row[mapping.transaction_id]);
        const dateResult = parseDateValue(row[mapping.settlement_date], false);
        const amountResult = parseAmountValue(row[mapping.settlement_amount]);
        const issues = [];

        if (!id) {
            issues.push('transaction ID is blank');
        }
        if (dateResult.error) {
            issues.push(`settlement date ${dateResult.error}`);
        }
        if (amountResult.error) {
            issues.push(`settlement amount ${amountResult.error}`);
        }

        if (issues.length) {
            invalidCount += 1;
            if (errors.length < 8) {
                errors.push(`Settlements CSV row ${rowNumber}: ${issues.join(', ')}.`);
            }
            return;
        }

        if (dateResult.warning) {
            warningCount += 1;
            if (warnings.length < 6) {
                warnings.push(`Settlements CSV row ${rowNumber}: ${dateResult.warning}.`);
            }
        }

        rows.push({
            settlement_id: getOptionalValue(row, optionalMappings, 'settlement_id'),
            transaction_id: id,
            settlement_date: dateResult.value,
            settlement_amount: amountResult.value,
            utr: getOptionalValue(row, optionalMappings, 'utr'),
            bank_reference: getOptionalValue(row, optionalMappings, 'bank_reference'),
            status: getOptionalValue(row, optionalMappings, 'status', 'SETTLED') || 'SETTLED',
        });
    });

    if (invalidCount > errors.length) {
        errors.push(`Settlements CSV has ${invalidCount - errors.length} more invalid row(s).`);
    }
    if (warningCount > warnings.length) {
        warnings.push(`Settlements CSV has ${warningCount - warnings.length} more date parsing warning(s).`);
    }

    return { rows, errors, warnings };
}

function buildMappingWarnings(mapping) {
    const warnings = [];
    const txnAmountHeader = normalizeHeaderName(mapping.txn.expected_amount);
    if (txnAmountHeader === 'amount' || txnAmountHeader.includes('gross')) {
        warnings.push('Transactions amount field looks generic. Prefer a net or expected receivable amount when available.');
    }
    return warnings;
}

function buildCanonicalDatasets(txnPayload, stlPayload, mapping) {
    const txnOptionalMappings = detectOptionalMappings(txnPayload.headers, 'txn', mapping.txn);
    const stlOptionalMappings = detectOptionalMappings(stlPayload.headers, 'stl', mapping.stl);
    const normalizedTxn = normalizeTransactions(txnPayload, mapping.txn, txnOptionalMappings);
    const normalizedStl = normalizeSettlements(stlPayload, mapping.stl, stlOptionalMappings);

    const errors = dedupeMessages([...normalizedTxn.errors, ...normalizedStl.errors]);
    const warnings = dedupeMessages([
        ...(txnPayload.warnings || []),
        ...(stlPayload.warnings || []),
        ...buildMappingWarnings(mapping),
        ...normalizedTxn.warnings,
        ...normalizedStl.warnings,
    ]);

    if (!normalizedTxn.rows.length) {
        errors.unshift('Transactions CSV did not produce any valid rows after mapping.');
    }
    if (!normalizedStl.rows.length) {
        errors.unshift('Settlements CSV did not produce any valid rows after mapping.');
    }

    return {
        transactions: normalizedTxn.rows,
        settlements: normalizedStl.rows,
        warnings,
        errors,
    };
}

function handleUploadPayload(kind, payload) {
    clearDataset(kind);
    inputMode = 'upload';

    if (!payload.headers.length) {
        setUploadStatus(kind, 'No columns detected in this CSV.', true);
        setUploadLoaded(kind, false);
        refreshMappingPanel();
        updateReadyState();
        return;
    }
    if (!payload.rows.length) {
        setUploadStatus(kind, 'CSV loaded but contains no data rows.', true);
        setUploadLoaded(kind, false);
        refreshMappingPanel();
        updateReadyState();
        return;
    }

    if (kind === 'txn') {
        rawTxnData = payload;
        dom.txnFileName.textContent = payload.fileName;
    } else {
        rawStlData = payload;
        dom.stlFileName.textContent = payload.fileName;
    }

    const warningSuffix = payload.warnings.length ? ` | ${payload.warnings.length} parser warning(s)` : '';
    setUploadStatus(kind, `${payload.rows.length} rows loaded${warningSuffix}`);
    setUploadLoaded(kind, true);
    refreshMappingPanel();
    updateReadyState();
}

function parseCsvFile(file, kind) {
    if (!file || !file.name.toLowerCase().endsWith('.csv')) {
        setUploadStatus(kind, 'Please upload a CSV file.', true);
        setUploadLoaded(kind, false);
        return;
    }

    if (inputMode === 'sample') {
        clearAllUploadState();
    }

    Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        transformHeader: (header) => normalizeCell(header),
        complete: (results) => handleUploadPayload(kind, buildPayloadFromResults(file.name, results)),
        error: (error) => {
            clearDataset(kind);
            setUploadStatus(kind, `Failed to read CSV: ${error.message}`, true);
            setUploadLoaded(kind, false);
            refreshMappingPanel();
            updateReadyState();
        },
    });
}

function setupUploadZone(zone, fileInput, kind) {
    zone.addEventListener('click', () => fileInput.click());

    zone.addEventListener('dragover', (event) => {
        event.preventDefault();
        zone.style.borderColor = 'var(--accent-indigo)';
    });

    zone.addEventListener('dragleave', () => {
        zone.style.borderColor = '';
    });

    zone.addEventListener('drop', (event) => {
        event.preventDefault();
        zone.style.borderColor = '';
        parseCsvFile(event.dataTransfer.files[0], kind);
    });

    fileInput.addEventListener('change', (event) => {
        parseCsvFile(event.target.files[0], kind);
    });
}

setupUploadZone(dom.txnUploadZone, dom.txnFileInput, 'txn');
setupUploadZone(dom.stlUploadZone, dom.stlFileInput, 'stl');

dom.mappingPanel.addEventListener('change', (event) => {
    if (!event.target.classList.contains('mapping-select')) {
        return;
    }
    currentMapping = collectMappingSelections();
    clearMappedData();
    renderPendingMappingState();
});

dom.btnApplyMapping.addEventListener('click', () => {
    if (!(rawTxnData && rawStlData)) {
        return;
    }

    const originalLabel = dom.btnApplyMapping.innerHTML;
    dom.btnApplyMapping.disabled = true;
    dom.btnApplyMapping.innerHTML = '<span class="spinner"></span> Validating...';

    setTimeout(() => {
        currentMapping = collectMappingSelections();
        const mappingProblems = findMappingProblems(currentMapping);

        if (mappingProblems.length) {
            clearMappedData();
            renderMessage(dom.mappingMessage, 'mapping-message', 'error', mappingProblems);
            renderValidationPanel('error', ['Fix the mapping issues before running reconciliation.']);
            setMappingBadge('Mapping blocked', 'error');
            dom.btnApplyMapping.innerHTML = originalLabel;
            updateReadyState();
            return;
        }

        const validation = buildCanonicalDatasets(rawTxnData, rawStlData, currentMapping);
        if (validation.errors.length) {
            clearMappedData();
            renderMessage(dom.mappingMessage, 'mapping-message', 'error', [
                'The uploaded files could not be normalized with the current mapping.',
                'Fix the CSV or adjust the selected columns, then apply again.',
            ]);
            renderValidationPanel('error', [...validation.errors, ...validation.warnings]);
            setMappingBadge('Mapping blocked', 'error');
            dom.btnApplyMapping.innerHTML = originalLabel;
            updateReadyState();
            return;
        }

        txnData = validation.transactions;
        stlData = validation.settlements;
        mappingApplied = true;

        const successLines = [
            `Transactions ready: ${txnData.length} normalized row(s).`,
            `Settlements ready: ${stlData.length} normalized row(s).`,
            ...validation.warnings,
        ];

        renderMessage(dom.mappingMessage, 'mapping-message', 'success', ['Mapping applied successfully. Uploaded files are ready for reconciliation.']);
        renderValidationPanel('success', successLines);
        setMappingBadge('Mapping applied', 'ready');
        dom.btnApplyMapping.innerHTML = originalLabel;
        updateReadyState();
    }, 30);
});

dom.btnSample.addEventListener('click', async () => {
    const originalLabel = dom.btnSample.innerHTML;
    dom.btnSample.disabled = true;
    dom.btnSample.innerHTML = '<span class="spinner"></span> Loading...';

    try {
        const [txnText, stlText] = await Promise.all([
            fetch(SAMPLE_TXN_URL).then((response) => response.text()),
            fetch(SAMPLE_STL_URL).then((response) => response.text()),
        ]);

        const txnPayload = parseCsvText(txnText, 'sample_transactions.csv');
        const stlPayload = parseCsvText(stlText, 'sample_settlements.csv');
        const sampleMapping = {
            txn: {
                transaction_id: 'transaction_id',
                transaction_date: 'transaction_date',
                expected_amount: txnPayload.headers.includes('net_amount') ? 'net_amount' : 'amount',
            },
            stl: {
                transaction_id: 'transaction_id',
                settlement_date: 'settlement_date',
                settlement_amount: 'settlement_amount',
            },
        };

        const validation = buildCanonicalDatasets(txnPayload, stlPayload, sampleMapping);
        if (validation.errors.length) {
            throw new Error(validation.errors[0]);
        }

        inputMode = 'sample';
        rawTxnData = txnPayload;
        rawStlData = stlPayload;
        txnData = validation.transactions;
        stlData = validation.settlements;
        currentMapping = sampleMapping;
        mappingApplied = true;

        setUploadLoaded('txn', true);
        setUploadLoaded('stl', true);
        setUploadStatus('txn', `${txnPayload.rows.length} rows loaded (sample)`);
        setUploadStatus('stl', `${stlPayload.rows.length} rows loaded (sample)`);
        dom.mappingPanel.classList.add('hidden');
        renderMessage(dom.mappingMessage, 'mapping-message', '', []);
        renderValidationPanel('', []);
        setMappingBadge('Waiting for files', '');
        updateReadyState();
    } catch (error) {
        inputMode = null;
        clearMappedData();
        setUploadStatus('txn', `Failed to load sample data: ${error.message}`, true);
        setUploadStatus('stl', 'Sample data was not loaded.', true);
    } finally {
        dom.btnSample.disabled = false;
        dom.btnSample.innerHTML = originalLabel;
    }
});
function reconcile(transactions, settlements) {
    console.group('%c[RECONCILE] Starting Reconciliation', 'color: #2196F3; font-weight: bold; font-size: 14px');
    console.log('[RECONCILE] Input transactions count:', transactions.length);
    console.log('[RECONCILE] Input settlements count:', settlements.length);
    console.log('[RECONCILE] Row mismatch tolerance:', rowMismatchTolerance);
    console.log('[RECONCILE] First 3 transactions:', JSON.parse(JSON.stringify(transactions.slice(0, 3))));
    console.log('[RECONCILE] First 3 settlements:', JSON.parse(JSON.stringify(settlements.slice(0, 3))));

    const txnIdCount = {};
    transactions.forEach((transaction) => {
        txnIdCount[transaction.transaction_id] = (txnIdCount[transaction.transaction_id] || 0) + 1;
    });

    const stlIdCount = {};
    settlements.forEach((settlement) => {
        stlIdCount[settlement.transaction_id] = (stlIdCount[settlement.transaction_id] || 0) + 1;
    });

    const duplicates = [];
    Object.entries(txnIdCount).forEach(([transactionId, count]) => {
        if (count <= 1) {
            return;
        }
        const rows = transactions.filter((row) => row.transaction_id === transactionId);
        duplicates.push({
            transaction_id: transactionId,
            occurrences: count,
            dataset: 'transactions',
            rows,
            order_id: rows[0].order_id || '',
            amount: rows[0].net_amount || 0,
            payment_method: rows[0].payment_method || '',
        });
    });

    Object.entries(stlIdCount).forEach(([transactionId, count]) => {
        if (count <= 1) {
            return;
        }
        const rows = settlements.filter((row) => row.transaction_id === transactionId);
        duplicates.push({
            transaction_id: transactionId,
            occurrences: count,
            dataset: 'bank_settlements',
            rows,
            order_id: '',
            amount: rows[0].settlement_amount || 0,
            payment_method: '',
        });
    });

    const txnMap = {};
    transactions.forEach((transaction) => {
        if (!txnMap[transaction.transaction_id]) {
            txnMap[transaction.transaction_id] = transaction;
        }
    });

    const stlMap = {};
    settlements.forEach((settlement) => {
        if (!stlMap[settlement.transaction_id]) {
            stlMap[settlement.transaction_id] = settlement;
        }
    });

    const txnIds = new Set(Object.keys(txnMap));
    const stlIds = new Set(Object.keys(stlMap));
    console.log('[RECONCILE] Unique txn IDs:', txnIds.size);
    console.log('[RECONCILE] Unique stl IDs:', stlIds.size);
    const commonIds = [...txnIds].filter(id => stlIds.has(id));
    console.log('[RECONCILE] IDs found in BOTH datasets:', commonIds.length);

    const orphanRefunds = [];
    const missingSettlements = [];
    const matched = [];
    const crossMonth = [];
    const amountMismatches = [];
    
    // Variance calculation: only rows with significant differences (> tolerance)
    let varianceExpectedTotal = 0;
    let varianceActualTotal = 0;
    let variancePairsCount = 0;
    let varianceExcludedWithinToleranceRows = 0;
    
    // Separate tracking for "clean matched" (same month, within tolerance)
    let cleanMatchedExpected = 0;
    let cleanMatchedActual = 0;
    let cleanMatchedCount = 0;
    let toleratedRoundingRows = 0;

    // Debug: track every non-zero difference
    const debugNonZeroDiffs = [];

    stlIds.forEach((transactionId) => {
        if (!txnIds.has(transactionId)) {
            const settlement = stlMap[transactionId];
            orphanRefunds.push({
                settlement_id: settlement.settlement_id,
                transaction_id: transactionId,
                settlement_amount: settlement.settlement_amount,
                settlement_date: settlement.settlement_date,
                utr: settlement.utr,
                bank_reference: settlement.bank_reference,
            });
        }
    });

    txnIds.forEach((transactionId) => {
        if (!stlIds.has(transactionId)) {
            const transaction = txnMap[transactionId];
            missingSettlements.push({
                transaction_id: transactionId,
                transaction_date: transaction.transaction_date,
                amount: transaction.amount,
                net_amount: transaction.net_amount,
                status: transaction.status,
            });
            return;
        }

        const transaction = txnMap[transactionId];
        const settlement = stlMap[transactionId];
        const expectedAmount = Number(transaction.net_amount);
        const actualAmount = Number(settlement.settlement_amount);
        // Signed difference: positive = platform expected more (SHORT), negative = bank paid more (OVER)
        const signedDiff = Math.round((expectedAmount - actualAmount) * 100) / 100;
        const difference = signedDiff; // Keep signed for display
        const absDifference = Math.abs(signedDiff); // Absolute for tolerance check
        const isCrossMonth = transaction.transaction_date.slice(0, 7) !== settlement.settlement_date.slice(0, 7);

        // DEBUG: Log every pair
        if (signedDiff !== 0) {
            debugNonZeroDiffs.push({
                id: transactionId,
                expected: expectedAmount,
                actual: actualAmount,
                diff: signedDiff,
                absDiff: absDifference,
                isCrossMonth,
                withinTolerance: absDifference <= rowMismatchTolerance,
                txnNetAmount_raw: transaction.net_amount,
                stlAmount_raw: settlement.settlement_amount,
            });
        }

        const record = {
            transaction_id: transactionId,
            transaction_date: transaction.transaction_date,
            settlement_date: settlement.settlement_date,
            expected_amount: expectedAmount,
            actual_amount: actualAmount,
            difference,
            payment_method: transaction.payment_method,
            merchant_id: transaction.merchant_id,
            order_id: transaction.order_id,
            utr: settlement.utr,
        };

        // Include in variance only when difference is above tolerance
        if (absDifference > rowMismatchTolerance) {
            varianceExpectedTotal += expectedAmount;
            varianceActualTotal += actualAmount;
            variancePairsCount += 1;
        } else {
            varianceExcludedWithinToleranceRows += 1;
        }

        let category;
        if (isCrossMonth) {
            crossMonth.push(record);
            category = 'CROSS_MONTH';
        } else if (absDifference > rowMismatchTolerance) {
            amountMismatches.push(record);
            category = 'AMOUNT_MISMATCH';
        } else {
            matched.push(record);
            cleanMatchedExpected += expectedAmount;
            cleanMatchedActual += actualAmount;
            cleanMatchedCount += 1;
            if (absDifference > 0 && absDifference <= rowMismatchTolerance) {
                toleratedRoundingRows += 1;
                category = 'TOLERATED_ROUNDING';
            } else {
                category = 'CLEAN_MATCH';
            }
        }

        // Log every single pair with its categorization
        console.log(`[RECONCILE PAIR] ID=${transactionId} | expected=${expectedAmount} | actual=${actualAmount} | diff=${signedDiff} | absDiff=${absDifference} | category=${category}`);
    });

    // Round all totals
    console.group('%c[RECONCILE] Pre-rounding Totals', 'color: #FF9800; font-weight: bold');
    console.log('[RECONCILE] varianceExpectedTotal (raw sum):', varianceExpectedTotal);
    console.log('[RECONCILE] varianceActualTotal (raw sum):', varianceActualTotal);
    console.log('[RECONCILE] raw diff (expected - actual):', varianceExpectedTotal - varianceActualTotal);
    console.groupEnd();

    varianceExpectedTotal = Math.round(varianceExpectedTotal * 100) / 100;
    varianceActualTotal = Math.round(varianceActualTotal * 100) / 100;
    const totalVariance = Math.round((varianceExpectedTotal - varianceActualTotal) * 100) / 100;
    
    cleanMatchedExpected = Math.round(cleanMatchedExpected * 100) / 100;
    cleanMatchedActual = Math.round(cleanMatchedActual * 100) / 100;
    const cleanMatchedVariance = Math.round((cleanMatchedExpected - cleanMatchedActual) * 100) / 100;

    console.group('%c[RECONCILE] Final Summary', 'color: #4CAF50; font-weight: bold; font-size: 13px');
    console.log('[RECONCILE] Rows in variance scope (> tolerance):', variancePairsCount);
    console.log('[RECONCILE] Rows excluded by tolerance:', varianceExcludedWithinToleranceRows);
    console.log('[RECONCILE] Clean matched:', cleanMatchedCount);
    console.log('[RECONCILE] Cross-month:', crossMonth.length);
    console.log('[RECONCILE] Amount mismatches:', amountMismatches.length);
    console.log('[RECONCILE] Missing settlements:', missingSettlements.length);
    console.log('[RECONCILE] Orphan refunds:', orphanRefunds.length);
    console.log('[RECONCILE] Tolerated rounding rows:', toleratedRoundingRows);
    console.log('[RECONCILE] Variance Expected Total:', varianceExpectedTotal);
    console.log('[RECONCILE] Variance Actual Total:', varianceActualTotal);
    console.log('[RECONCILE] Total Variance (expected - actual):', totalVariance);
    console.log('[RECONCILE] Clean Matched Variance:', cleanMatchedVariance);
    console.groupEnd();

    if (debugNonZeroDiffs.length > 0) {
        console.group('%c[RECONCILE] ALL Non-Zero Differences (' + debugNonZeroDiffs.length + ' rows)', 'color: #f44336; font-weight: bold; font-size: 13px');
        console.table(debugNonZeroDiffs);
        console.groupEnd();
    } else {
        console.log('%c[RECONCILE] No non-zero differences found across any matched pairs!', 'color: #4CAF50; font-weight: bold');
    }

    console.groupEnd(); // end of Starting Reconciliation group

    return {
        summary: {
            total_transactions: transactions.length,
            total_settlements: settlements.length,
            matched: matched.length,
            cross_month: crossMonth.length,
            amount_mismatches: amountMismatches.length,
            duplicates_in_transactions: duplicates.filter((item) => item.dataset === 'transactions').length,
            duplicates_in_settlements: duplicates.filter((item) => item.dataset === 'bank_settlements').length,
            missing_settlements: missingSettlements.length,
            orphan_refunds: orphanRefunds.length,
            row_mismatch_tolerance: rowMismatchTolerance,
            // Variance for rows with abs(difference) > row tolerance
            variance_pairs_count: variancePairsCount,
            variance_excluded_within_tolerance_rows: varianceExcludedWithinToleranceRows,
            variance_expected_amount: varianceExpectedTotal,
            variance_actual_amount: varianceActualTotal,
            total_variance: totalVariance,
            // Clean matched subset (same month, within tolerance)
            clean_matched_count: cleanMatchedCount,
            clean_matched_expected: cleanMatchedExpected,
            clean_matched_actual: cleanMatchedActual,
            clean_matched_variance: cleanMatchedVariance,
            tolerated_rounding_rows: toleratedRoundingRows,
        },
        discrepancies: {
            cross_month: crossMonth,
            amount_mismatches: amountMismatches,
            duplicates,
            orphan_refunds: orphanRefunds,
            missing_settlements: missingSettlements,
            variance_breakdown: {
                total_matched_ids: commonIds.length,
                rows_included_in_variance: variancePairsCount,
                rows_excluded_by_tolerance: varianceExcludedWithinToleranceRows,
                expected_total: varianceExpectedTotal,
                actual_total: varianceActualTotal,
                total_variance: totalVariance,
                clean_matched_variance: cleanMatchedVariance,
                rows_with_tolerated_rounding: toleratedRoundingRows,
                row_tolerance: rowMismatchTolerance,
            },
        },
        matched,
    };
}

function statusPillHtml(status) {
    const labels = {
        MATCHED: 'Matched',
        CROSS_MONTH: 'Cross-Month',
        AMOUNT_MISMATCH: 'Mismatch',
        MISSING_SETTLEMENT: 'Orphan',
        ORPHAN_REFUND: 'Orphan',
    };
    const classes = {
        MATCHED: 'matched',
        CROSS_MONTH: 'cross-month',
        AMOUNT_MISMATCH: 'mismatch',
        MISSING_SETTLEMENT: 'orphan',
        ORPHAN_REFUND: 'orphan',
    };
    return `<span class="status-pill ${classes[status] || ''}">${labels[status] || status}</span>`;
}

function formatAmount(value) {
    if (value === undefined || value === null || value === '' || Number.isNaN(Number(value))) {
        return '-';
    }
    return Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function diffHtml(value) {
    if (!value || value === 0) {
        return '<span class="diff-zero">0.00</span>';
    }
    const absValue = Math.abs(value);
    const formatted = absValue.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    // Positive = Expected > Actual (SHORT - bank paid less)
    // Negative = Expected < Actual (OVER - bank paid more)
    if (value > 0) {
        return `<span class="diff-short">+${escapeHtml(formatted)}</span>`;
    } else {
        return `<span class="diff-over">−${escapeHtml(formatted)}</span>`;
    }
}

function renderEmptyState(tbody, colSpan, message) {
    tbody.innerHTML = `<tr><td class="table-empty" colspan="${colSpan}">${escapeHtml(message)}</td></tr>`;
}

function renderAllTable(rows, searchQuery = '') {
    const tbody = document.querySelector('#table-all tbody');
    if (!rows.length) {
        const message = searchQuery 
            ? `No results found for "${searchQuery}"` 
            : 'No rows to display.';
        renderEmptyState(tbody, 9, message);
        return;
    }

    tbody.innerHTML = rows.map((row) => `
        <tr>
            <td>${statusPillHtml(row.status)}</td>
            <td>${escapeHtml(row.transaction_id || '-')}</td>
            <td>${escapeHtml(row.transaction_date || '-')}</td>
            <td>${escapeHtml(row.settlement_date || '-')}</td>
            <td>${escapeHtml(formatAmount(row.expected_amount))}</td>
            <td>${escapeHtml(formatAmount(row.actual_amount))}</td>
            <td>${diffHtml(row.difference)}</td>
            <td>${escapeHtml(row.payment_method || '-')}</td>
            <td>${escapeHtml(row.merchant_id || '-')}</td>
        </tr>
    `).join('');
}

function renderCrossMonthTable(rows) {
    const tbody = document.querySelector('#table-cross-month tbody');
    if (!rows.length) {
        renderEmptyState(tbody, 8, 'No cross-month rows found.');
        return;
    }

    tbody.innerHTML = rows.map((row) => `
        <tr>
            <td>${escapeHtml(row.transaction_id)}</td>
            <td>${escapeHtml(row.transaction_date)}</td>
            <td>${escapeHtml(row.settlement_date)}</td>
            <td>${escapeHtml(formatAmount(row.expected_amount))}</td>
            <td>${escapeHtml(formatAmount(row.actual_amount))}</td>
            <td>${diffHtml(row.difference)}</td>
            <td>${escapeHtml(row.payment_method || '-')}</td>
            <td>${escapeHtml(row.utr || '-')}</td>
        </tr>
    `).join('');
}

function renderMismatchTable(rows) {
    const tbody = document.querySelector('#table-mismatch tbody');
    if (!rows.length) {
        renderEmptyState(tbody, 7, 'No amount mismatches found.');
        return;
    }

    tbody.innerHTML = rows.map((row) => `
        <tr>
            <td>${escapeHtml(row.transaction_id)}</td>
            <td>${escapeHtml(formatAmount(row.expected_amount))}</td>
            <td>${escapeHtml(formatAmount(row.actual_amount))}</td>
            <td>${diffHtml(row.difference)}</td>
            <td>${escapeHtml(row.transaction_date)}</td>
            <td>${escapeHtml(row.payment_method || '-')}</td>
            <td>${escapeHtml(row.merchant_id || '-')}</td>
        </tr>
    `).join('');
}
function renderDuplicatesTable(rows) {
    const tbody = document.querySelector('#table-duplicates tbody');
    if (!rows.length) {
        renderEmptyState(tbody, 6, 'No duplicate transaction IDs found.');
        return;
    }

    tbody.innerHTML = rows.map((row) => `
        <tr>
            <td>${escapeHtml(row.transaction_id)}</td>
            <td>${escapeHtml(row.occurrences)}</td>
            <td>${escapeHtml(row.dataset)}</td>
            <td>${escapeHtml(row.order_id || '-')}</td>
            <td>${escapeHtml(formatAmount(row.amount))}</td>
            <td>${escapeHtml(row.payment_method || '-')}</td>
        </tr>
    `).join('');
}

function renderOrphansTable(orphanRefunds, missingSettlements) {
    const tbody = document.querySelector('#table-orphans tbody');
    const allOrphans = [
        ...(orphanRefunds || []).map(row => ({ ...row, orphan_type: 'Bank Orphan' })),
        ...(missingSettlements || []).map(row => ({ ...row, orphan_type: 'Missing Settlement' })),
    ];
    
    if (!allOrphans.length) {
        renderEmptyState(tbody, 6, 'No orphan rows found.');
        return;
    }

    tbody.innerHTML = allOrphans.map((row) => `
        <tr>
            <td><span class="status-pill ${row.orphan_type === 'Bank Orphan' ? 'orphan' : 'missing-orphan'}">${escapeHtml(row.orphan_type)}</span></td>
            <td>${escapeHtml(row.transaction_id || '-')}</td>
            <td>${escapeHtml(formatAmount(row.settlement_amount ?? row.net_amount ?? 0))}</td>
            <td>${escapeHtml(row.settlement_date || row.transaction_date || '-')}</td>
            <td>${escapeHtml(row.utr || '-')}</td>
            <td>${escapeHtml(row.bank_reference || '-')}</td>
        </tr>
    `).join('');
}

function animateCount(elementId, target) {
    const element = document.getElementById(elementId);
    element.classList.add('animate');
    const duration = 600;
    const start = performance.now();

    function step(timestamp) {
        const progress = Math.min((timestamp - start) / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        element.textContent = Math.round(eased * target);
        if (progress < 1) {
            requestAnimationFrame(step);
        }
    }

    requestAnimationFrame(step);
}

function renderResults(report) {
    console.group('%c[RENDER] renderResults() called', 'color: #9C27B0; font-weight: bold; font-size: 14px');

    animateCount('card-matched', report.summary.matched);
    animateCount('card-cross-month', report.summary.cross_month);
    animateCount('card-mismatch', report.summary.amount_mismatches);
    animateCount('card-duplicates', report.summary.duplicates_in_transactions + report.summary.duplicates_in_settlements);
    animateCount('card-orphans', report.summary.orphan_refunds + report.summary.missing_settlements);

    // Reconciliation Variance (only rows with |difference| > tolerance)
    const expectedTotal = Number(report.summary.variance_expected_amount || 0);
    const actualTotal = Number(report.summary.variance_actual_amount || 0);
    const variance = Number(report.summary.total_variance || 0);
    const varianceSign = variance > 0 ? 'SHORT' : variance < 0 ? 'OVER' : 'BALANCED';
    const varianceClass = variance === 0 ? 'variance-balanced' : (variance > 0 ? 'variance-short' : 'variance-over');
    const matchedPairs = Number(report.summary.variance_pairs_count || 0);
    const varianceExcludedByTolerance = Number(
        report.summary.variance_excluded_within_tolerance_rows
        ?? report.discrepancies?.variance_breakdown?.rows_excluded_by_tolerance
        ?? 0
    );
    const toleratedRows = Number(report.summary.tolerated_rounding_rows || 0);
    const rowTolerance = Number(report.discrepancies?.variance_breakdown?.row_tolerance ?? rowMismatchTolerance);

    console.log('[RENDER] expectedTotal from summary:', expectedTotal);
    console.log('[RENDER] actualTotal from summary:', actualTotal);
    console.log('[RENDER] variance from summary:', variance, '→', varianceSign);
    console.log('[RENDER] matchedPairs:', matchedPairs);

    // Amount mismatch totals - sum of signed differences and absolute differences
    const mismatchNetFromRows = Array.isArray(report.discrepancies?.amount_mismatches)
        ? report.discrepancies.amount_mismatches.reduce((sum, row) => sum + Number(row.difference || 0), 0)
        : 0;
    const mismatchAbsFromRows = Array.isArray(report.discrepancies?.amount_mismatches)
        ? report.discrepancies.amount_mismatches.reduce((sum, row) => sum + Math.abs(Number(row.difference || 0)), 0)
        : 0;
    const mismatchNet = Math.round(mismatchNetFromRows * 100) / 100;
    const mismatchAbs = Math.round(mismatchAbsFromRows * 100) / 100;
    const mismatchCount = Number(report.summary.amount_mismatches || 0);

    console.log('[RENDER] Amount mismatch count:', mismatchCount);
    console.log('[RENDER] Mismatch net total:', mismatchNet);
    console.log('[RENDER] Mismatch abs total:', mismatchAbs);

    // Cross-month totals (shown for context; only out-of-tolerance rows enter variance)
    const crossMonthTotal = Array.isArray(report.discrepancies?.cross_month)
        ? report.discrepancies.cross_month.reduce((sum, row) => sum + Number(row.expected_amount || 0), 0)
        : 0;
    const crossMonthDiff = Array.isArray(report.discrepancies?.cross_month)
        ? report.discrepancies.cross_month.reduce((sum, row) => sum + Number(row.difference || 0), 0)
        : 0;

    console.log('[RENDER] Cross-month rows:', (report.discrepancies?.cross_month || []).length);
    console.log('[RENDER] Cross-month total expected:', crossMonthTotal);
    console.log('[RENDER] Cross-month total diff:', crossMonthDiff);
    
    // Orphan totals (NOT in variance - IDs don't match)
    const orphanTotal = Array.isArray(report.discrepancies?.orphan_refunds)
        ? report.discrepancies.orphan_refunds.reduce((sum, row) => sum + Number(row.settlement_amount || 0), 0)
        : 0;

    console.log('[RENDER] Orphan refunds total:', orphanTotal);

    // Variance scope rows: matched IDs whose absolute difference exceeds tolerance
    const allMatchedRows = [
        ...(report.matched || []),
        ...(report.discrepancies?.cross_month || []),
        ...(report.discrepancies?.amount_mismatches || []),
    ];
    const varianceRows = allMatchedRows.filter(
        (row) => Math.abs(Number(row.difference || 0)) > rowTolerance
    );
    const totalAbsDiff = Math.round(varianceRows.reduce((sum, row) => sum + Math.abs(Number(row.difference || 0)), 0) * 100) / 100;

    console.log('[RENDER] allMatchedRows count:', allMatchedRows.length, '(matched:', (report.matched || []).length, '+ crossMonth:', (report.discrepancies?.cross_month || []).length, '+ mismatches:', (report.discrepancies?.amount_mismatches || []).length, ')');
    console.log('[RENDER] varianceRows count (|diff| > tolerance):', varianceRows.length);
    console.log('[RENDER] totalAbsDiff:', totalAbsDiff);

    // Calculate SHORT and OVER totals separately
    let shortTotal = 0;
    let overTotal = 0;
    const shortRows = [];
    const overRows = [];
    varianceRows.forEach(row => {
        const diff = Number(row.difference || 0);
        if (diff > 0) {
            shortTotal += diff;  // Expected > Actual = SHORT
            shortRows.push({ id: row.transaction_id, diff, expected: row.expected_amount, actual: row.actual_amount });
        }
        else if (diff < 0) {
            overTotal += Math.abs(diff);  // Expected < Actual = OVER
            overRows.push({ id: row.transaction_id, diff, expected: row.expected_amount, actual: row.actual_amount });
        }
    });
    shortTotal = Math.round(shortTotal * 100) / 100;
    overTotal = Math.round(overTotal * 100) / 100;

    console.group('%c[RENDER] SHORT/OVER Breakdown', 'color: #E91E63; font-weight: bold');
    console.log('[RENDER] Short total (bank paid less):', shortTotal, '| Rows contributing:', shortRows.length);
    if (shortRows.length > 0) console.table(shortRows);
    console.log('[RENDER] Over total (bank paid more):', overTotal, '| Rows contributing:', overRows.length);
    if (overRows.length > 0) console.table(overRows);
    console.log('[RENDER] Net variance (short - over):', Math.round((shortTotal - overTotal) * 100) / 100);
    console.groupEnd();
    console.groupEnd(); // end renderResults group

    dom.aggregateRoundingNote.innerHTML = `
        <div class="variance-section">
            <div class="variance-header">
                <strong>💰 RECONCILIATION VARIANCE</strong>
                <span class="variance-scope">(Only rows where |difference| &gt; tolerance)</span>
            </div>
            <div class="variance-grid">
                <div class="variance-row">
                    <span class="variance-label">Rows in Variance Scope:</span>
                    <span class="variance-value"><strong>${matchedPairs}</strong> transactions</span>
                </div>
                <div class="variance-row">
                    <span class="variance-label">Excluded by Tolerance:</span>
                    <span class="variance-value">${varianceExcludedByTolerance} transactions</span>
                </div>
                <div class="variance-row">
                    <span class="variance-label">Expected Amount (Platform):</span>
                    <span class="variance-value">₹${formatAmount(expectedTotal)}</span>
                </div>
                <div class="variance-row">
                    <span class="variance-label">Actual Amount (Bank):</span>
                    <span class="variance-value">₹${formatAmount(actualTotal)}</span>
                </div>
                <div class="variance-row variance-short-over">
                    <span class="variance-label">Short Amount <small>(bank paid less)</small>:</span>
                    <span class="variance-value"><span class="diff-short">+₹${formatAmount(shortTotal)}</span></span>
                </div>
                <div class="variance-row variance-short-over">
                    <span class="variance-label">Over Amount <small>(bank paid more)</small>:</span>
                    <span class="variance-value"><span class="diff-over">−₹${formatAmount(overTotal)}</span></span>
                </div>
                <div class="variance-row variance-total ${varianceClass}">
                    <span class="variance-label"><strong>NET VARIANCE:</strong> <small>(Short − Over)</small></span>
                    <span class="variance-value"><strong>${variance >= 0 ? '+' : '−'}₹${formatAmount(Math.abs(variance))} ${varianceSign}</strong></span>
                </div>
                <div class="variance-row">
                    <span class="variance-label">Total Absolute Differences:</span>
                    <span class="variance-value">₹${formatAmount(totalAbsDiff)} <small>(sum of |differences| in variance scope)</small></span>
                </div>
            </div>
            <div class="variance-details">
                <span>Clean Matched: <strong>${report.summary.matched}</strong> txns</span>
                <span>Cross-Month: <strong>${report.summary.cross_month}</strong> txns</span>
                <span>Amount Mismatches: <strong>${mismatchCount}</strong> txns (net: ${mismatchNet >= 0 ? '+' : ''}₹${formatAmount(mismatchNet)})</span>
                <span>Tolerated Rounding: <strong>${toleratedRows}</strong> rows (≤₹${formatAmount(rowTolerance)} each, excluded from variance)</span>
            </div>
            <div class="diff-legend">
                <span class="diff-legend-item"><span class="diff-short">+</span> = SHORT (bank paid less than expected)</span>
                <span class="diff-legend-item"><span class="diff-over">−</span> = OVER (bank paid more than expected)</span>
            </div>
        </div>
        <div class="excluded-section">
            <div class="excluded-header"><strong>ℹ️ NOT Included in Variance (IDs not matched):</strong></div>
            <div class="excluded-items">
                <span>Orphan Refunds: ${report.summary.orphan_refunds} rows (₹${formatAmount(orphanTotal)})</span>
                <span>Missing Settlements: ${report.summary.missing_settlements} txns</span>
                <span>Duplicates: ${report.summary.duplicates_in_transactions + report.summary.duplicates_in_settlements} entries</span>
            </div>
        </div>
    `;
    dom.aggregateRoundingNote.classList.remove('hidden');

    const allTransactions = [];
    report.matched.forEach((row) => allTransactions.push({ ...row, status: 'MATCHED' }));
    report.discrepancies.cross_month.forEach((row) => allTransactions.push({ ...row, status: 'CROSS_MONTH' }));
    report.discrepancies.amount_mismatches.forEach((row) => allTransactions.push({ ...row, status: 'AMOUNT_MISMATCH' }));
    report.discrepancies.missing_settlements.forEach((row) => {
        allTransactions.push({
            ...row,
            status: 'MISSING_SETTLEMENT',
            expected_amount: row.net_amount,
            actual_amount: 0,
            difference: row.net_amount,
            settlement_date: '-',
            payment_method: '',
            merchant_id: '',
        });
    });
    report.discrepancies.orphan_refunds.forEach((row) => {
        allTransactions.push({
            ...row,
            status: 'ORPHAN_REFUND',
            transaction_date: '-',
            expected_amount: 0,
            actual_amount: row.settlement_amount,
            difference: Math.abs(row.settlement_amount),
            payment_method: '',
            merchant_id: '',
        });
    });

    allTransactions.sort((left, right) => String(left.transaction_date || '').localeCompare(String(right.transaction_date || '')));
    renderAllTable(allTransactions);
    renderCrossMonthTable(report.discrepancies.cross_month);
    renderMismatchTable(report.discrepancies.amount_mismatches);
    renderDuplicatesTable(report.discrepancies.duplicates);
    renderOrphansTable(report.discrepancies.orphan_refunds, report.discrepancies.missing_settlements);
    window._allTxns = allTransactions;
}

dom.btnReconcile.addEventListener('click', () => {
    if (!(txnData && stlData)) {
        return;
    }

    const originalLabel = dom.btnReconcile.innerHTML;
    dom.btnReconcile.disabled = true;
    dom.btnReconcile.innerHTML = '<span class="spinner"></span> Reconciling...';

    setTimeout(() => {
        try {
            reconciliationReport = reconcile(txnData, stlData);
            renderResults(reconciliationReport);
            persistResultsState();
            dom.resultsSection.classList.remove('hidden');
            dom.resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } catch (error) {
            renderMessage(dom.mappingMessage, 'mapping-message', 'error', [
                `Reconciliation failed: ${error.message}`,
                'Review the uploaded files and mapping selections, then try again.',
            ]);
            renderValidationPanel('error', ['Unexpected runtime failure while reconciling the uploaded data.']);
            setMappingBadge('Run failed', 'error');
        } finally {
            dom.btnReconcile.innerHTML = originalLabel;
            updateReadyState();
        }
    }, 40);
});

document.getElementById('tab-bar').addEventListener('click', (event) => {
    if (!event.target.classList.contains('tab')) {
        return;
    }

    const tabId = event.target.dataset.tab;
    document.querySelectorAll('.tab').forEach((tab) => tab.classList.remove('active'));
    event.target.classList.add('active');
    document.querySelectorAll('.tab-panel').forEach((panel) => panel.classList.remove('active'));
    document.getElementById(`panel-${tabId}`).classList.add('active');
});

dom.searchInput.addEventListener('input', (event) => {
    const query = event.target.value.toLowerCase().trim();
    if (!window._allTxns) {
        return;
    }

    const filtered = query
        ? window._allTxns.filter((row) =>
            String(row.transaction_id || '').toLowerCase().includes(query)
            || String(row.order_id || '').toLowerCase().includes(query)
            || String(row.merchant_id || '').toLowerCase().includes(query)
            || String(row.payment_method || '').toLowerCase().includes(query)
            || String(row.utr || '').toLowerCase().includes(query)
            || String(row.status || '').toLowerCase().includes(query)
        )
        : window._allTxns;

    renderAllTable(filtered, query);
});

dom.rowToleranceInput.addEventListener('change', () => {
    const previousTolerance = rowMismatchTolerance;
    applyToleranceSettingFromInput();
    if (reconciliationReport && previousTolerance !== rowMismatchTolerance) {
        dom.rowToleranceHelp.textContent = `Differences up to ₹${rowMismatchTolerance.toFixed(2)} are treated as rounding tolerance and excluded from mismatch and variance totals. Run reconciliation again to apply this new value.`;
    }
});

dom.rowToleranceInput.addEventListener('blur', () => {
    applyToleranceSettingFromInput();
});

document.querySelector('#table-all thead').addEventListener('click', (event) => {
    const header = event.target.closest('th');
    if (!header || !header.dataset.sort || !window._allTxns) {
        return;
    }

    const column = header.dataset.sort;
    if (currentSort.column === column) {
        currentSort.ascending = !currentSort.ascending;
    } else {
        currentSort.column = column;
        currentSort.ascending = true;
    }

    const sorted = [...window._allTxns].sort((left, right) => {
        const leftValue = left[column] ?? '';
        const rightValue = right[column] ?? '';
        const leftNumber = Number(leftValue);
        const rightNumber = Number(rightValue);

        if (!Number.isNaN(leftNumber) && !Number.isNaN(rightNumber) && leftValue !== '' && rightValue !== '') {
            return currentSort.ascending ? leftNumber - rightNumber : rightNumber - leftNumber;
        }

        return currentSort.ascending
            ? String(leftValue).localeCompare(String(rightValue))
            : String(rightValue).localeCompare(String(leftValue));
    });

    renderAllTable(sorted);
});

applyToleranceSettingFromInput();
restoreResultsState();
updateReadyState();


