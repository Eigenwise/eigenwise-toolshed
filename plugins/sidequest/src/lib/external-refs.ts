import { execFileSync } from './git-process';

export type ExternalReference = { key: string; url: string | null };

export function githubRepository(remote: string): string | null {
  return /^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(remote.trim())?.[1] ?? null;
}

export function originRepository(project: string): string | null {
  try {
    return githubRepository(execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: project, encoding: 'utf8', stdio: 'pipe', timeout: 10000 }));
  } catch { return null; }
}

export function githubReference(value: string, repository: string | null): ExternalReference | null {
  const url = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(issues|pull)\/(\d+)\/?$/i.exec(value);
  if (url) return { key: 'GH-' + Number(url[3]), url: 'https://github.com/' + url[1] + '/' + url[2] + '/' + Number(url[3]) };
  const qualified = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(value);
  if (qualified) return { key: 'GH-' + Number(qualified[2]), url: 'https://github.com/' + qualified[1] + '/issues/' + Number(qualified[2]) };
  const local = /^(?:GH-|#)(\d+)$/.exec(value);
  if (local && repository) return { key: 'GH-' + Number(local[1]), url: 'https://github.com/' + repository + '/issues/' + Number(local[1]) };
  return null;
}

export function externalReference(value: string, repository: string | null, jiraBaseUrl: string | null): ExternalReference {
  const github = githubReference(value, repository);
  if (github) return github;
  if (/^[A-Z][A-Z0-9]+-\d+$/.test(value) && !value.startsWith('GH-')) {
    return { key: value, url: jiraBaseUrl ? jiraBaseUrl + '/browse/' + value : null };
  }
  throw new Error('Invalid external ref "' + value + '". Accepted: GH-123 or #123 (GitHub origin required), owner/repo#123, https://github.com/owner/repo/issues/123 or /pull/123, Jira key ABC-123.');
}

export function referenceKeys(references: ExternalReference[] = []): string[] {
  return references.map((reference) => reference.key);
}

export function referenceHeader(references: ExternalReference[] = []): string[] {
  return references.length ? ['Refs: ' + referenceKeys(references).join(', ')] : [];
}
