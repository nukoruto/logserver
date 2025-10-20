import { cp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(__dirname, '..', 'static');
const destination = path.join(__dirname, '..', 'dist', 'static');

await cp(source, destination, { recursive: true });
