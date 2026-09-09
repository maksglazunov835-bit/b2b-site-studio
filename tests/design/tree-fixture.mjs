// Synthetic lifecycle fixture only. Never invokes a model.
import { spawn } from 'node:child_process';
import { writeFile, access } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const [mode, marker, pipes, leaderExit] = process.argv.slice(2);
if (mode === 'leaf') {
  process.on('SIGTERM', () => {});
  await writeFile(marker, String(process.pid));
  setInterval(() => {}, 1000);
} else {
  const leaf = spawn(process.execPath, [process.argv[1], 'leaf', marker], {
    stdio: pipes === 'closed' ? 'ignore' : ['ignore', 'inherit', 'inherit'],
  });
  leaf.unref();
  for (;;) {
    try {
      await access(marker);
      break;
    } catch {
      await delay(10);
    }
  }
  if (leaderExit === 'forbidden') {
    console.log(
      JSON.stringify({ type: 'thread.started', thread_id: 'synthetic' }),
    );
    console.log(JSON.stringify({ type: 'turn.started' }));
    console.log(
      JSON.stringify({
        type: 'item.started',
        item: { type: 'command_execution', id: 'forbidden' },
      }),
    );
  } else console.log('FIXTURE_READY');
  if (leaderExit === 'yes') process.exit(0);
  setInterval(() => {}, 1000);
}
