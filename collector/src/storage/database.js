const fs = require('fs/promises');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const configModule = require('../config');
const config = configModule.default || configModule;
const loggerModule = require('../utils/logger');
const logger = loggerModule.default || loggerModule;

let db;

const ensureDatabase = async () => {
  if (db) {
    return db;
  }

  await fs.mkdir(path.dirname(config.sqlitePath), { recursive: true });
  db = await new Promise((resolve, reject) => {
    const instance = new sqlite3.Database(config.sqlitePath, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(instance);
    });
  });

  await run('PRAGMA journal_mode = WAL;');
  await run('PRAGMA foreign_keys = ON;');
  logger.info(`SQLite database initialised at ${config.sqlitePath}`);
  return db;
};

const run = (sql, params = []) =>
  new Promise((resolve, reject) => {
    ensureDatabase()
      .then((database) => {
        database.run(sql, params, function onComplete(err) {
          if (err) {
            reject(err);
            return;
          }
          resolve({ lastID: this.lastID, changes: this.changes });
        });
      })
      .catch(reject);
  });

const all = (sql, params = []) =>
  new Promise((resolve, reject) => {
    ensureDatabase()
      .then((database) => {
        database.all(sql, params, (err, rows) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(rows);
        });
      })
      .catch(reject);
  });

const get = (sql, params = []) =>
  new Promise((resolve, reject) => {
    ensureDatabase()
      .then((database) => {
        database.get(sql, params, (err, row) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(row);
        });
      })
      .catch(reject);
  });

module.exports = {
  ensureDatabase,
  run,
  all,
  get,
};
