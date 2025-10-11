'use strict';

const path = require('node:path');
const fs = require('node:fs');

const unique = (items) => Array.from(new Set(items.filter(Boolean)));

const DEFAULT_SCENARIO_FILE = path.join(__dirname, 'defaultFlow.json');
const EXTERNAL_DEFAULT_PRIMARY = path.resolve(process.cwd(), 'configs', 'scenario_default.json');
const EXTERNAL_DEFAULT_SECONDARY = path.resolve(process.cwd(), '..', 'configs', 'scenario_default.json');
const EXTERNAL_DEFAULT_FILE = EXTERNAL_DEFAULT_PRIMARY;
const EXTERNAL_DEFAULT_CANDIDATES = unique([
  EXTERNAL_DEFAULT_PRIMARY,
  EXTERNAL_DEFAULT_SECONDARY,
]);

const resolveCandidatePaths = (filePath) => {
  const candidates = [];
  const override = process.env.SIM_SCENARIO_FILE;
  if (filePath) {
    const normalized = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(process.cwd(), filePath);
    candidates.push(normalized);
    if (!path.isAbsolute(filePath)) {
      candidates.push(path.join(__dirname, filePath));
    }
  }
  if (override) {
    const normalizedOverride = path.isAbsolute(override)
      ? override
      : path.resolve(process.cwd(), override);
    candidates.push(normalizedOverride);
  }
  EXTERNAL_DEFAULT_CANDIDATES.forEach((candidate) => {
    candidates.push(candidate);
  });
  candidates.push(DEFAULT_SCENARIO_FILE);
  return unique(candidates);
};

const readScenarioFile = (candidatePath) => {
  if (!candidatePath) {
    return null;
  }
  if (!fs.existsSync(candidatePath)) {
    return null;
  }
  const rawContent = fs.readFileSync(candidatePath, 'utf8');
  try {
    return JSON.parse(rawContent);
  } catch (error) {
    throw new Error(`Failed to parse scenario JSON at ${candidatePath}: ${error instanceof Error ? error.message : error}`);
  }
};

const loadScenario = (filePath = null) => {
  const candidates = resolveCandidatePaths(filePath);
  for (const candidate of candidates) {
    const data = readScenarioFile(candidate);
    if (data) {
      if (!data.id && filePath && candidate === filePath) {
        data.id = path.basename(candidate, path.extname(candidate));
      }
      return data;
    }
  }

  // TODO: Introduce scenario registry service once GUI editor is available.
  throw new Error(`Unable to locate scenario definition. Checked: ${candidates.join(', ')}`);
};

module.exports = {
  DEFAULT_SCENARIO_FILE,
  EXTERNAL_DEFAULT_FILE,
  loadScenario,
};
