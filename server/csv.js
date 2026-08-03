/**
 * csv.js
 * Saves PANAS evaluation results to CSV files.
 */

const fs = require('fs');

const CSV_COLUMNS = [
  'source_image',
  'direction',
  'output_file',
  'interested',
  'excited',
  'strong',
  'enthusiastic',
  'proud',
  'alert',
  'inspired',
  'determined',
  'attentive',
  'active',
  'distressed',
  'upset',
  'guilty',
  'scared',
  'hostile',
  'irritable',
  'ashamed',
  'nervous',
  'jittery',
  'afraid',
  'positive_affect_score',
  'negative_affect_score',
  'net_affect_score',
  'brief_description',
  'error',
];

/**
 * Save results array to CSV.
 * Appends a summary row at the bottom with averaged PANAS scores.
 */
function saveResults(results, outputPath) {
  const lines = [];

  // Header
  lines.push(CSV_COLUMNS.join(','));

  // Data rows
  for (const row of results) {
    const cells = CSV_COLUMNS.map(col => {
      const val = row[col];
      if (val === undefined || val === null) return '';
      const str = String(val);
      // Escape CSV: wrap in quotes if contains comma, quote, or newline
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    });
    lines.push(cells.join(','));
  }

  // Compute and append summary rows
  const valid = results.filter(r => r.positive_affect_score !== undefined && !r.error);
  if (valid.length > 0) {
    lines.push(''); // blank separator line

    const avg = (key) => {
      const sum = valid.reduce((s, r) => s + (parseFloat(r[key]) || 0), 0);
      return (sum / valid.length).toFixed(2);
    };

    // Summary header
    lines.push('--- SUMMARY ---');

    const summaryItems = [
      'interested','excited','strong','enthusiastic','proud','alert',
      'inspired','determined','attentive','active',
      'distressed','upset','guilty','scared','hostile',
      'irritable','ashamed','nervous','jittery','afraid',
      'positive_affect_score','negative_affect_score','net_affect_score'
    ];

    const summaryCells = CSV_COLUMNS.map(col => {
      if (col === 'source_image') return valid[0]?.source_image || '';
      if (col === 'direction') return 'AVERAGE';
      if (col === 'output_file') return `n=${valid.length}`;
      if (summaryItems.includes(col)) return avg(col);
      return '';
    });
    lines.push(summaryCells.join(','));

    // Also add score interpretation
    const avgPA = parseFloat(avg('positive_affect_score'));
    const avgNA = parseFloat(avg('negative_affect_score'));
    const avgNet = parseFloat(avg('net_affect_score'));
    lines.push('');
    lines.push(`"Positive Affect Average: ${avgPA}/50 | Negative Affect Average: ${avgNA}/50 | Net Affect: ${avgNet}"`);
    lines.push(`"Interpretation: ${getInterpretation(avgPA, avgNA)}"`);
  }

  fs.writeFileSync(outputPath, lines.join('\n'), 'utf-8');
}

function readResults(inputPath) {
  if (!fs.existsSync(inputPath)) return [];

  const text = fs.readFileSync(inputPath, 'utf-8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter(line => {
    const trimmed = line.trim();
    return trimmed && trimmed !== '--- SUMMARY ---' && !trimmed.startsWith('"Positive Affect Average:') && !trimmed.startsWith('"Interpretation:');
  });

  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]);
  const rows = [];

  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line);
    const row = {};

    for (let i = 0; i < headers.length; i++) {
      row[headers[i]] = cells[i] ?? '';
    }

    if (!row.direction || row.direction === 'AVERAGE') continue;
    rows.push(coerceResultRow(row));
  }

  return rows;
}

function parseCsvLine(line) {
  const cells = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];

    if (ch === '"' && inQuotes && next === '"') {
      cell += '"';
      i++;
    } else if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      cells.push(cell);
      cell = '';
    } else {
      cell += ch;
    }
  }

  cells.push(cell);
  return cells;
}

function coerceResultRow(row) {
  const numericColumns = CSV_COLUMNS.filter(col => !['source_image', 'direction', 'output_file', 'brief_description', 'error'].includes(col));

  for (const col of numericColumns) {
    if (row[col] !== '') {
      const n = Number(row[col]);
      row[col] = Number.isNaN(n) ? row[col] : n;
    }
  }

  return row;
}

function getInterpretation(pa, na) {
  const netAffect = pa - na;
  if (pa >= 35 && na <= 20) return 'Highly positive environment - strongly promotes wellbeing';
  if (pa >= 25 && na <= 25) return 'Positive environment - generally promotes wellbeing';
  if (pa >= 20 && na >= 30) return 'Stressful environment - may negatively impact wellbeing';
  if (pa <= 20 && na >= 35) return 'Highly negative environment - significantly impacts wellbeing';
  if (netAffect >= 10) return 'Moderately positive environment';
  if (netAffect <= -10) return 'Moderately negative environment';
  return 'Neutral environment - mixed emotional responses';
}

module.exports = { saveResults, readResults };
