import { spawn } from 'node:child_process';

// "The Sandbox": the Actor agent's generated shell script actually runs
// inside a throwaway Docker container — this is real right now (no sponsor
// credits needed, just a local Docker daemon), which makes it the one leg
// of the demo you can prove is genuinely executing, not simulated.

export interface SandboxResult {
  ranInDocker: boolean;
  exitCode: number | null;
  log: string;
}

let dockerAvailable: boolean | undefined;

export async function dockerIsAvailable(): Promise<boolean> {
  if (dockerAvailable !== undefined) return dockerAvailable;
  dockerAvailable = await new Promise<boolean>((resolve) => {
    const p = spawn('docker', ['info'], { stdio: 'ignore' });
    p.on('error', () => resolve(false));
    p.on('exit', (code) => resolve(code === 0));
  });
  return dockerAvailable;
}

/**
 * Runs `script` (a small POSIX shell script) inside a fresh, network-less
 * busybox container and returns its stdout/stderr as the sandbox log.
 */
export async function runInDockerSandbox(script: string, timeoutMs = 15_000): Promise<SandboxResult> {
  if (!(await dockerIsAvailable())) {
    return {
      ranInDocker: false,
      exitCode: null,
      log: '[docker unavailable — showing what would have run]\n' + script,
    };
  }

  return new Promise((resolve) => {
    const args = ['run', '--rm', '--network', 'none', 'busybox', 'sh', '-c', script];
    const proc = spawn('docker', args);
    let log = '';
    const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);

    proc.stdout.on('data', (d) => (log += d.toString()));
    proc.stderr.on('data', (d) => (log += d.toString()));
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ranInDocker: true, exitCode: code, log });
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ranInDocker: false, exitCode: null, log: `[docker error] ${String(err)}` });
    });
  });
}
