import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

process.umask(0o077);

const startupArguments = process.argv.slice(2);
const requestedEntry = startupArguments[0];

if (requestedEntry === undefined || !isAbsolute(requestedEntry)) {
  process.stderr.write('FLOW_CLI_ENTRY_INVALID\n');
  process.exitCode = 78;
} else {
  try {
    const metadata = await lstat(requestedEntry);
    const entry = await realpath(requestedEntry);
    if (metadata.isSymbolicLink() || !metadata.isFile() || !isAbsolute(entry)) {
      throw new Error('FLOW_CLI_ENTRY_INVALID');
    }
    const cliArguments = startupArguments.slice(1);
    process.argv = [process.execPath, entry, ...cliArguments];
    await import(pathToFileURL(entry).href);
  } catch {
    process.stderr.write('FLOW_CLI_ENTRY_INVALID\n');
    process.exitCode = 78;
  }
}
