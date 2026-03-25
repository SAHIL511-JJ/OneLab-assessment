
/**
 * Payment Reconciliation Dashboard - upload-safe client-side engine.
 */

const SAMPLE_TXN_URL = './data/transactions.csv';
const SAMPLE_STL_URL = './data/bank_settlements.csv';

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
};

function normalizeHeaderName(value) {
    return String(value || '').toLowerCase().trim().replace(/[^a-z0-9]/g, '');
}

function normalizeCell(value) {
    return value == null ? '' : String(value).trim();
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\"/g, '&quot;')
        .replace(/'/g, '&#39;');
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
    window._allTxns = null;
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
    return document.getElementById(`map-${dataset}-${key.replace(/_/g, '-')}`);
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
        .replace(/,/g, '')
        .replace(/\s+/g, '')
        .replace(/inr/ig, '')
        .replace(/rs\.?/ig, '')
        .replace(/[\$\u20b9\u00a3\u20ac]/g, '');

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

    const cleaned = raw.replace(/\s+/g, ' ').trim();
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
    const orphanRefunds = [];
    const missingSettlements = [];
    const matched = [];
    const crossMonth = [];
    const amountMismatches = [];

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
        const difference = Math.round(Math.abs(expectedAmount - actualAmount) * 100) / 100;
        const isCrossMonth = transaction.transaction_date.slice(0, 7) !== settlement.settlement_date.slice(0, 7);

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

        if (isCrossMonth) {
            crossMonth.push(record);
        } else if (difference > 0.001) {
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
            duplicates_in_transactions: duplicates.filter((item) => item.dataset === 'transactions').length,
            duplicates_in_settlements: duplicates.filter((item) => item.dataset === 'bank_settlements').length,
            missing_settlements: missingSettlements.length,
            orphan_refunds: orphanRefunds.length,
        },
        discrepancies: {
            cross_month: crossMonth,
            amount_mismatches: amountMismatches,
            duplicates,
            orphan_refunds: orphanRefunds,
            missing_settlements: missingSettlements,
        },
        matched,
    };
}

function statusPillHtml(status) {
    const labels = {
        MATCHED: 'Matched',
        CROSS_MONTH: 'Cross-Month',
        AMOUNT_MISMATCH: 'Mismatch',
        MISSING_SETTLEMENT: 'Missing',
        ORPHAN_REFUND: 'Orphan',
    };
    const classes = {
        MATCHED: 'matched',
        CROSS_MONTH: 'cross-month',
        AMOUNT_MISMATCH: 'mismatch',
        MISSING_SETTLEMENT: 'mismatch',
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
    return `<span class="diff-positive">${escapeHtml(formatAmount(value))}</span>`;
}

function renderEmptyState(tbody, colSpan, message) {
    tbody.innerHTML = `<tr><td class="table-empty" colspan="${colSpan}">${escapeHtml(message)}</td></tr>`;
}

function renderAllTable(rows) {
    const tbody = document.querySelector('#table-all tbody');
    if (!rows.length) {
        renderEmptyState(tbody, 9, 'No rows to display.');
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

function renderOrphansTable(rows) {
    const tbody = document.querySelector('#table-orphans tbody');
    if (!rows.length) {
        renderEmptyState(tbody, 6, 'No orphan settlements found.');
        return;
    }

    tbody.innerHTML = rows.map((row) => `
        <tr>
            <td>${escapeHtml(row.settlement_id || '-')}</td>
            <td>${escapeHtml(row.transaction_id)}</td>
            <td>${escapeHtml(formatAmount(row.settlement_amount))}</td>
            <td>${escapeHtml(row.settlement_date)}</td>
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
    animateCount('card-matched', report.summary.matched);
    animateCount('card-cross-month', report.summary.cross_month);
    animateCount('card-mismatch', report.summary.amount_mismatches);
    animateCount('card-duplicates', report.summary.duplicates_in_transactions + report.summary.duplicates_in_settlements);
    animateCount('card-orphans', report.summary.orphan_refunds);

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
    renderOrphansTable(report.discrepancies.orphan_refunds);
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
        )
        : window._allTxns;

    renderAllTable(filtered);
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

updateReadyState();

