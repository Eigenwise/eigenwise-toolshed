#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pluginRoot } from './shared/paths.js';

export const SCHEMA_VERSION = 1;

interface Breadcrumb {
  schemaVersion: number;
  name: string;
  version: string;
  root: string;
  capabilities: string[];
}

interface WriteBreadcrumbOptions {
  root?: string;
  home?: string;
  version?: string;
}

export function pluginVersion(root: string): string {
  const parsed: unknown = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
  if (!parsed || typeof parsed !== 'object' || !('version' in parsed)) throw new Error('plugin manifest has no version');
  return String((parsed as { version: unknown }).version);
}

export function registryPath(home = os.homedir()): string {
  return path.join(home, '.claude', 'toolshed', 'registry', 'sidequest.json');
}

function futureSchema(file: string): boolean {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || !('schemaVersion' in value)) return false;
    const schemaVersion = (value as { schemaVersion: unknown }).schemaVersion;
    return Number.isInteger(schemaVersion) && Number(schemaVersion) > SCHEMA_VERSION;
  } catch (_) {
    return false;
  }
}

function writeAtomically(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch (_) {}
  }
}

export function breadcrumb(root: string, version: string): Breadcrumb {
  return {
    schemaVersion: SCHEMA_VERSION,
    name: 'sidequest',
    version,
    root,
    capabilities: ['tickets', 'dashboard'],
  };
}

export function writeBreadcrumb(options: WriteBreadcrumbOptions = {}): { written: boolean; reason?: string; file: string } {
  const root = options.root || pluginRoot();
  const home = options.home || os.homedir();
  const version = options.version || pluginVersion(root);
  const file = registryPath(home);
  if (futureSchema(file)) return { written: false, reason: 'future-schema', file };
  writeAtomically(file, breadcrumb(root, version));
  return { written: true, file };
}

if (require.main === module) {
  try { writeBreadcrumb(); } catch (_) {}
}
