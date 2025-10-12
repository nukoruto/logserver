import { promises as fs } from 'fs';
import path from 'path';

const TARGET_DIRECTORIES = [
  path.resolve(__dirname, '..', '..', '..', 'dataset'),
  path.resolve(__dirname, '..', '..', '..', 'outputs'),
];

const TEXT_EXTENSIONS = new Set(['.csv', '.json', '.log', '.md', '.txt', '.yaml', '.yml']);
// Base64URL 3-segment tokens (JWT 形式) を検出。grep -E '[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.'
// に倣いつつ、誤検出（module.path 等）を避けるため各セグメント長を 8 文字以上に制限する。
const JWT_PATTERN = /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/;

const isTextFile = (filePath: string): boolean => {
  const ext = path.extname(filePath).toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
};

async function collectFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  const stack: string[] = [dir];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    let stat;
    try {
      stat = await fs.stat(current);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      let entries: string[] = [];
      try {
        entries = await fs.readdir(current);
      } catch {
        continue;
      }
      for (const entry of entries) {
        stack.push(path.join(current, entry));
      }
    } else if (stat.isFile() && isTextFile(current)) {
      results.push(current);
    }
  }

  return results;
}

describe('artifact pseudonymisation hygiene', () => {
  it('does not leak raw JWT tokens in stored metadata', async () => {
    const offenders: string[] = [];

    for (const dir of TARGET_DIRECTORIES) {
      let stat;
      try {
        stat = await fs.stat(dir);
      } catch {
        continue;
      }

      if (!stat.isDirectory()) {
        continue;
      }

      const files = await collectFiles(dir);
      for (const file of files) {
        let content: string;
        try {
          content = await fs.readFile(file, 'utf8');
        } catch {
          continue;
        }

        if (JWT_PATTERN.test(content)) {
          offenders.push(file);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
