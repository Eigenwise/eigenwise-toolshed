'use strict';

const typescript = require('./language-server-locators/typescript');
const python = require('./language-server-locators/python');

const LOCATORS = new Map([
  ['typescript', typescript],
  ['python', python],
]);

function languageForFile(filePath) {
  const extension = require('node:path').extname(filePath).toLowerCase();
  for (const [language, locator] of LOCATORS) {
    if (locator.extensions.includes(extension)) return language;
  }
  return null;
}

function locateLanguageServer(languageOrRootDir, rootDirOrEnv, env = process.env, filePath) {
  const language = LOCATORS.has(languageOrRootDir) ? languageOrRootDir : 'typescript';
  const rootDir = language === languageOrRootDir ? rootDirOrEnv : languageOrRootDir;
  const locatorEnv = language === languageOrRootDir ? env : (rootDirOrEnv || process.env);
  const locator = LOCATORS.get(language);
  if (!locator) return { error: `No language server locator is available for ${language}.` };
  return locator.locate(rootDir, locatorEnv, filePath);
}

function registerLanguageServerLocator(language, locator) {
  if (typeof language !== 'string' || !language) throw new Error('language must be a non-empty string.');
  if (!locator || !Array.isArray(locator.extensions) || typeof locator.locate !== 'function') {
    throw new Error(`locator for ${language} must provide extensions and locate.`);
  }
  LOCATORS.set(language, locator);
}

function unregisterLanguageServerLocator(language) {
  if (language !== 'typescript') LOCATORS.delete(language);
}

module.exports = {
  locateLanguageServer,
  languageForFile,
  registerLanguageServerLocator,
  unregisterLanguageServerLocator,
  NATIVE_SERVER_ENV: typescript.NATIVE_SERVER_ENV,
  LANGUAGE_SERVER_ENV: typescript.LANGUAGE_SERVER_ENV,
  PYRIGHT_SERVER_ENV: python.PYRIGHT_SERVER_ENV,
  PYTHON_INTERPRETER_ENV: python.PYTHON_INTERPRETER_ENV,
};
