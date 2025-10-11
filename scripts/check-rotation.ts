import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const CSV_EXTENSION = '.csv';
const DEFAULT_WINDOW_MINUTES = 5;

type RotationMode = 'daily' | 'hourly';

type CheckRotationOptions = {
  dir: string;
  windowMinutes: number;
};

type BoundaryReport = {
  boundaryIso: string;
  previousFile: string;
  nextFile: string;
  previousCount: number;
  nextCount: number;
  previousMin: string | null;
  previousMax: string | null;
  nextMin: string | null;
  nextMax: string | null;
  gapMs: number | null;
  issues: string[];
};

const parseArgs = (argv: string[]): CheckRotationOptions => {
  const options: CheckRotationOptions = { dir: '', windowMinutes: DEFAULT_WINDOW_MINUTES };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dir' || arg === '--path') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`${arg} requires a value`);
      }
      options.dir = value;
      index += 1;
    } else if (arg === '--window-minutes' || arg === '--window') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`${arg} requires a value`);
      }
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`Invalid window minutes: ${value}`);
      }
      options.windowMinutes = parsed;
      index += 1;
    }
  }

  if (!options.dir) {
    throw new Error('Missing required --dir argument');
  }

  return options;
};

const parseCsvLine = (line: string): string[] => {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
};

const collectCsvFiles = async (inputDir: string): Promise<string[]> => {
  const baseDir = path.resolve(process.cwd(), inputDir);
  const results: string[] = [];

  const traverse = async (target: string): Promise<void> => {
    const stats = await stat(target);
    if (stats.isDirectory()) {
      const entries = await readdir(target);
      await Promise.all(entries.map((entry) => traverse(path.join(target, entry))));
      return;
    }
    if (stats.isFile() && target.endsWith(CSV_EXTENSION)) {
      results.push(target);
    }
  };

  await traverse(baseDir);
  results.sort();
  return results;
};

const inferRotationMode = (files: readonly string[]): RotationMode => {
  let detected: RotationMode | null = null;

  for (const file of files) {
    const base = path.basename(file, CSV_EXTENSION);
    const segments = base.split('-');
    if (segments.length === 4) {
      if (detected && detected !== 'hourly') {
        throw new Error('Mixed rotation formats detected (daily and hourly)');
      }
      detected = 'hourly';
    } else if (segments.length === 3) {
      if (detected && detected !== 'daily') {
        throw new Error('Mixed rotation formats detected (daily and hourly)');
      }
      if (!detected) {
        detected = 'daily';
      }
    }
  }

  return detected ?? 'daily';
};

const keyToBoundary = (key: string, mode: RotationMode): Date => {
  const segments = key.split('-');
  if (mode === 'hourly' && segments.length >= 4) {
    const [year, month, day, hour] = segments;
    return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour)));
  }
  const [year, month, day] = segments;
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
};

const parseTimestampColumn = (content: string, file: string): number[] => {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return [];
  }

  const header = parseCsvLine(lines[0]);
  const timestampIndex = header.indexOf('timestamp_utc');
  if (timestampIndex === -1) {
    throw new Error(`File ${file} is missing timestamp_utc column`);
  }

  const timestamps: number[] = [];

  for (let index = 1; index < lines.length; index += 1) {
    const cells = parseCsvLine(lines[index]);
    const value = cells[timestampIndex] ?? '';
    if (!value) {
      continue;
    }
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      timestamps.push(parsed);
    }
  }

  timestamps.sort((a, b) => a - b);
  return timestamps;
};

const formatIsoOrNull = (value: number | null): string | null => {
  if (value === null) {
    return null;
  }
  return new Date(value).toISOString();
};

const analyzeBoundaries = (
  files: readonly string[],
  mode: RotationMode,
  windowMinutes: number,
  timestampMap: Map<string, number[]>
): BoundaryReport[] => {
  const windowMs = windowMinutes * 60 * 1000;
  const reports: BoundaryReport[] = [];

  for (let index = 0; index < files.length - 1; index += 1) {
    const currentFile = files[index];
    const nextFile = files[index + 1];
    const nextKey = path.basename(nextFile, CSV_EXTENSION);
    const boundaryTime = keyToBoundary(nextKey, mode).getTime();
    const lower = boundaryTime - windowMs;
    const upper = boundaryTime + windowMs;

    const currentTimestamps = timestampMap.get(currentFile) ?? [];
    const nextTimestamps = timestampMap.get(nextFile) ?? [];

    const prevWindow = currentTimestamps.filter((value) => value >= lower && value <= boundaryTime);
    const nextWindow = nextTimestamps.filter((value) => value >= boundaryTime && value <= upper);

    const prevCount = prevWindow.length;
    const nextCount = nextWindow.length;
    const prevMin = prevCount > 0 ? prevWindow[0] : null;
    const prevMax = prevCount > 0 ? prevWindow[prevWindow.length - 1] : null;
    const nextMin = nextCount > 0 ? nextWindow[0] : null;
    const nextMax = nextCount > 0 ? nextWindow[nextWindow.length - 1] : null;

    const issues: string[] = [];

    if (prevCount === 0) {
      issues.push('missing_previous_window');
    }
    if (nextCount === 0) {
      issues.push('missing_next_window');
    }

    let gapMs: number | null = null;
    if (prevCount > 0 && nextCount > 0 && prevMax !== null && nextMin !== null) {
      gapMs = nextMin - prevMax;
      if (gapMs > windowMs) {
        issues.push('gap_exceeds_window');
      }
    }

    reports.push({
      boundaryIso: new Date(boundaryTime).toISOString(),
      previousFile: path.basename(currentFile),
      nextFile: path.basename(nextFile),
      previousCount: prevCount,
      nextCount: nextCount,
      previousMin: formatIsoOrNull(prevMin),
      previousMax: formatIsoOrNull(prevMax),
      nextMin: formatIsoOrNull(nextMin),
      nextMax: formatIsoOrNull(nextMax),
      gapMs,
      issues,
    });
  }

  return reports;
};

const main = async (): Promise<void> => {
  try {
    const options = parseArgs(process.argv.slice(2));
    const files = await collectCsvFiles(options.dir);
    if (files.length < 2) {
      throw new Error('At least two CSV files are required to evaluate rotation boundaries');
    }

    const rotationMode = inferRotationMode(files);
    const timestampMap = new Map<string, number[]>();

    for (const file of files) {
      const content = await readFile(file, 'utf8');
      const timestamps = parseTimestampColumn(content, file);
      timestampMap.set(file, timestamps);
    }

    const reports = analyzeBoundaries(files, rotationMode, options.windowMinutes, timestampMap);
    const failing = reports.filter((report) => report.issues.length > 0);

    console.log(
      JSON.stringify(
        {
          rotation: rotationMode,
          windowMinutes: options.windowMinutes,
          boundaries: reports.length,
          failing: failing.length,
          reports,
        },
        null,
        2
      )
    );

    if (failing.length > 0) {
      failing.forEach((report) => {
        console.error(
          `Rotation boundary ${report.boundaryIso} issues: ${report.issues.join(', ')} ` +
            `(prev=${report.previousFile}, next=${report.nextFile})`
        );
      });
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`[check-rotation] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
};

void main();
