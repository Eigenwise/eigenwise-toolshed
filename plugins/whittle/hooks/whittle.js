#!/usr/bin/env node
'use strict';

try {
  const runtime = require('./lib/runtime');
  const eventName = process.argv[2];
  const additionalContext = runtime.handleHook(eventName, runtime.readInput());
  if (additionalContext) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: eventName, additionalContext },
    }));
  }
} catch (_) {}
