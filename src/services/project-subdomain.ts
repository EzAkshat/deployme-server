import { randomBytes } from 'node:crypto';

const RESERVED_SUBDOMAINS = new Set([
  'www',
  'api',
  'app',
  'admin',
  'dashboard',
  'auth',
  'login',
  'accounts',
  'assets',
  'static',
  'cdn',
  'mail',
  'smtp',
  'imap',
  'pop',
  'webmail',
  'status',
  'support',
  'docs',
  'blog',
  'billing',
  'ns1',
  'ns2',
]);

export function normalizeProjectSubdomain(value: string): string | null {
  const normalized = value.trim().toLowerCase();

  if (
    normalized.length < 1 ||
    normalized.length > 63 ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized) ||
    RESERVED_SUBDOMAINS.has(normalized)
  ) {
    return null;
  }

  return normalized;
}
export function createRepositorySubdomainCandidate(
  repositoryName: string,
  attempt: number,
): string {
  let base = repositoryName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');

  if (!base) {
    base = 'project';
  }

  if (normalizeProjectSubdomain(base) === null) {
    base = `site-${base}`.slice(0, 63).replace(/-+$/g, '');
  }

  if (attempt === 0) {
    return base;
  }

  const suffix = randomBytes(4).toString('hex');
  const shortened = base.slice(0, 54).replace(/-+$/g, '');

  return `${shortened}-${suffix}`;
}
