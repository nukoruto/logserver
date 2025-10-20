import '../bootstrap/env';
import { collectMetricsSnapshot } from './snapshot';

const main = (): void => {
  const command = process.argv[2];
  if (command === 'print') {
    const payload = collectMetricsSnapshot();
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    process.exit(0);
  }

  console.error('usage: collector-metrics print');
  process.exit(2);
};

main();
