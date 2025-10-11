'use strict';

const path = require('node:path');
const fs = require('node:fs');

const DEFAULT_SCENARIO_FILE = path.join(__dirname, 'defaultFlow.json');

const loadScenario = (filePath = DEFAULT_SCENARIO_FILE) => {
  const targetPath = filePath || DEFAULT_SCENARIO_FILE;
  const resolvedPath = path.isAbsolute(targetPath)
    ? targetPath
    : path.join(__dirname, targetPath);

  const rawContent = fs.readFileSync(resolvedPath, 'utf8');
  return JSON.parse(rawContent);
};

module.exports = {
  DEFAULT_SCENARIO_FILE,
  loadScenario,
};
