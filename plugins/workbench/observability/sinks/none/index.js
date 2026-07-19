'use strict';

const ID = 'none';

function resolve() {
  return {
    id: ID,
    egress: 'none',
    collectorExporter: null,
    outbox: {
      enabled: false,
      endpoint: null,
      headers: {},
      allowRemote: false,
    },
  };
}

function setup() {
  return { configured: true };
}

function teardown() {
  return { configured: false };
}

module.exports = {
  ID,
  resolve,
  setup,
  teardown,
};
