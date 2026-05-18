// CSV export — downloads the current alert list as a UTF-8 CSV file
//
// Fields exported (matches Space-Track CDM schema):
//   CDM_ID, TCA, SAT1_NORAD, SAT1_NAME, SAT2_NORAD, SAT2_NAME,
//   MISS_DISTANCE_KM, PC, SAT2_OBJECT_TYPE

/**
 * Converts a CDM records array to a CSV string and triggers a browser download.
 *
 * @param {object[]} records  Filtered CDM records from alertPanel.
 * @param {string}   [filename]  Override default filename.
 */
export function exportAlertsCSV(records, filename) {
  const ts  = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const out = filename ?? `novasentinel-alerts-${ts}.csv`;

  const HEADERS = [
    'CDM_ID',
    'TCA_UTC',
    'SAT1_NORAD',
    'SAT1_NAME',
    'SAT2_NORAD',
    'SAT2_NAME',
    'MISS_DISTANCE_KM',
    'PC',
    'SAT2_TYPE',
    'RELATIVE_SPEED_KMS',
  ];

  const rows = records.map(r => [
    csvEscape(r.CDM_ID               ?? ''),
    csvEscape(r.TCA                   ?? ''),
    csvEscape(r.SAT1_NORAD_CAT_ID     ?? ''),
    csvEscape(r.SAT1_OBJECT_NAME      ?? r.SAT1_OBJECT_DESIGNATOR ?? ''),
    csvEscape(r.SAT2_NORAD_CAT_ID     ?? ''),
    csvEscape(r.SAT2_OBJECT_NAME      ?? r.SAT2_OBJECT_DESIGNATOR ?? ''),
    csvEscape(r.MISS_DISTANCE         ?? ''),
    csvEscape(r.PC                    ?? ''),
    csvEscape(r.SAT2_OBJECT_TYPE      ?? ''),
    csvEscape(r.RELATIVE_SPEED        ?? ''),
  ].join(','));

  const csv  = [HEADERS.join(','), ...rows].join('\r\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' }); // BOM for Excel

  const url  = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href     = url;
  link.download = out;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();

  // Cleanup
  setTimeout(() => {
    URL.revokeObjectURL(url);
    document.body.removeChild(link);
  }, 3000);

  console.info(`[exportCSV] Exported ${records.length} records → ${out}`);
}

/**
 * Escapes a value for CSV: wraps in quotes if it contains comma, quote, or newline.
 * @param {string|number} val
 * @returns {string}
 */
function csvEscape(val) {
  const s = String(val);
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}
