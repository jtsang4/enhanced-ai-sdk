import { execFile as _execFile } from 'node:child_process';

// Filter known noisy npm registry 404 lines from child process stderr (e.g. optional @boundaryml/* natives)
const NOISY_NPM_404 = /\/@boundaryml%2fbaml-/i;

export const execFile = (file: string, args: string[], cwd: string) =>
  new Promise<void>((resolveP, rejectP) => {
    const proc = _execFile(file, args, { cwd }, (err) => {
      if (err) rejectP(err);
      else resolveP();
    });
    proc.stdout?.on('data', (chunk: Buffer | string) => {
      process.stdout.write(chunk);
    });
    let stderrBuf = '';
    proc.stderr?.on('data', (chunk: Buffer | string) => {
      stderrBuf += chunk.toString();
      const lines = stderrBuf.split(/\r?\n/);
      // keep the last partial line in buffer
      stderrBuf = lines.pop() ?? '';
      for (const line of lines) {
        if (!NOISY_NPM_404.test(line)) {
          process.stderr.write(line + '\n');
        }
      }
    });
    proc.on('close', () => {
      if (stderrBuf && !NOISY_NPM_404.test(stderrBuf)) {
        process.stderr.write(stderrBuf);
      }
    });
  });

