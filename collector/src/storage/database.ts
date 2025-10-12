import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import sqlite3 from 'sqlite3';
import config from '../config';
import logger from '../utils/logger';

const sqlite = sqlite3.verbose();

let db: sqlite3.Database | null = null;

type SqlParams = readonly unknown[];

export const ensureDatabase = async (): Promise<sqlite3.Database> => {
  if (db) {
    return db;
  }

  await fsPromises.mkdir(path.dirname(config.sqlitePath), { recursive: true });
  db = await new Promise<sqlite3.Database>((resolve, reject) => {
    const instance = new sqlite.Database(config.sqlitePath, (error) => {
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

export const run = async (sql: string, params: SqlParams = []): Promise<sqlite3.RunResult> => {
  const database = await ensureDatabase();
  return new Promise((resolve, reject) => {
    database.run(sql, params, function onComplete(this: sqlite3.RunResult, err: Error | null) {
      if (err) {
        reject(err);
        return;
      }
      resolve(this);
    });
  });
};

export const all = async <T = Record<string, unknown>>(sql: string, params: SqlParams = []): Promise<T[]> => {
  const database = await ensureDatabase();
  return new Promise((resolve, reject) => {
    database.all(sql, params, (err: Error | null, rows: T[]) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(rows);
    });
  });
};

export const get = async <T = Record<string, unknown> | undefined>(sql: string, params: SqlParams = []): Promise<T | undefined> => {
  const database = await ensureDatabase();
  return new Promise((resolve, reject) => {
    database.get(sql, params, (err: Error | null, row: T | undefined) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(row);
    });
  });
};

export const databaseModule = {
  ensureDatabase,
  run,
  all,
  get,
};

export default databaseModule;
