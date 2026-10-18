import { execFileSync } from './git-process';

export function sanitizeIssueBody(body: string): string {
  return body.replace(/<!--[\s\S]*?-->/g, '').replace(/!\[[^\]]*\](?:\([^)]*\)|\[[^\]]*\])?/g, '').replace(/<img\b[^>]*>/gi, '').trim();
}

export function importGitHubIssue(url: string | undefined): { title?: string; body?: string; refs?: string[] } {
  if (url === undefined) return {};
  const match = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(issues|pull)\/\d+\/?$/.exec(url);
  if (!match) throw new Error('--github requires a GitHub issue or pull URL.');
  const kind = match[1] === 'pull' ? 'pr' : 'issue';
  let output: string;
  try {
    output = execFileSync('gh', [kind, 'view', url, '--json', 'number,title,body,url'], { encoding: 'utf8', stdio: 'pipe', timeout: 30000 });
  } catch (error: unknown) {
    throw new Error('GitHub import failed. Install gh if missing, run "gh auth login", then retry "gh ' + kind + ' view ' + url + ' --json number,title,body,url". ' + String(error));
  }
  const issue: { number: number; title: string; body: string; url: string } = JSON.parse(output);
  return { title: 'GH-' + issue.number + ': ' + issue.title, body: sanitizeIssueBody(issue.body), refs: [issue.url] };
}
