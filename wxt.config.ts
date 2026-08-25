import { defineConfig } from 'wxt';

export default defineConfig({
  manifestVersion: 3,
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'SubTwin',
    description:
      'Official-first English and Simplified Chinese subtitles for Netflix.',
    minimum_chrome_version: '111',
    permissions: ['storage'],
    host_permissions: [
      'https://www.netflix.com/*',
      'https://api.deepseek.com/*',
      'https://translate.googleapis.com/*',
    ],
  },
  zip: {
    artifactTemplate:
      '{{name}}-{{packageVersion}}-{{browser}}-{{manifestVersion}}.zip',
  },
});
