// Resolves which Firebase project the tools act on. The local emulators are the default; a real
// project needs an explicit flag, because seeding and resetting delete documents.

import { parseArgs } from 'node:util';

export const LOCAL_PROJECT = 'kestrel-bay-entries';

const EMULATOR_DEFAULTS = {
  FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
  FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
};

/**
 * @param {string[]} argv
 * @param {Record<string, import('node:util').ParseArgsOptionDescriptor>} extraOptions
 */
export function resolveTarget(argv, extraOptions = {}) {
  const { values } = parseArgs({
    args: argv,
    options: {
      project: { type: 'string' },
      'allow-remote': { type: 'boolean', default: false },
      ...extraOptions,
    },
    strict: true,
  });

  const remote = Boolean(values.project) && values.project !== LOCAL_PROJECT;
  if (remote && !values['allow-remote']) {
    throw new Error(
      `--project ${values.project} is not the local emulator project. ` +
        'Pass --allow-remote to act on a real project (use a staging project, never production).',
    );
  }

  if (!remote) {
    for (const [name, value] of Object.entries(EMULATOR_DEFAULTS)) {
      process.env[name] ??= value;
    }
    // No Google metadata server on a workstation; skip the credential probe and its warning.
    process.env.METADATA_SERVER_DETECTION ??= 'none';
  } else if (process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST) {
    throw new Error('Emulator host variables are set; unset them before targeting a real project.');
  }

  const projectId = values.project ?? LOCAL_PROJECT;
  process.env.GCLOUD_PROJECT = projectId;
  return {
    projectId,
    remote,
    values,
    authBase: remote ? 'https://identitytoolkit.googleapis.com' : `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com`,
  };
}

/**
 * Runs async work over items with at most `limit` in flight.
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<R[]>}
 */
export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(lanes);
  return results;
}
