'use strict';

function createServer({ database, deleteCachedRow, readGlobal, writeGlobal }: any) {
function readServerInfo() {
  return readGlobal('server-info', null);
}
function writeServerInfo(info?: any) {
  writeGlobal('server-info', info);
}
function clearServerInfo() {
  deleteCachedRow(database(), 'globals', 'server-info');
}


  return { readServerInfo, writeServerInfo, clearServerInfo };
}

module.exports = { createServer };
