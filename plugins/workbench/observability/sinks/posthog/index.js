'use strict';

const ID = 'posthog';

function unavailable() {
  throw new Error('The PostHog sink needs a canonical observation-to-PostHog event mapper before it can be enabled.');
}

module.exports = {
  ID,
  resolve: unavailable,
  setup: unavailable,
  teardown() {
    return { configured: false };
  },
};
